/**
 * The `contextActivity` session projection unit — the per-day activity ledger behind the
 * Context Insights page's heatmap and its last-7-days usage chart.
 *
 * The timeline unit (fold.ts) prices the context as it stands NOW, which cannot draw a per-day
 * chart, so this unit folds the committed event stream into a ledger keyed by local calendar day:
 * an assistant settlement adds one completed request, its billed buckets (uncached input + cache
 * read + cache write + output), and its per-(provider, model, period) pricing record. Buckets
 * attribute to the day the open STEP STARTED, falling back to the settlement instant; the
 * peak/off split prices the same instant. Each day also tallies its skill loads.
 *
 * The ledger is bounded by {@link MAX_KEPT_DAYS} keys and never materializes an `undefined`-valued
 * property.
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import { skillNameOf } from './fold'
import { addBilledUsage, copyCostUsage, tokenCountOf } from './foldMetering'
import type { BilledUsage, UsageLike } from './foldMetering'
import { costUsageSchema } from './timeline'
import { dayKeyOf } from '../shared/days'
import type { ActivityDay, ContextActivity } from '../shared/types'

/** Retention cap on ledger days: a little over a year of daily-active sessions. */
const MAX_KEPT_DAYS = 400

/** Cap on one day's skill-name table; a hostile replay could stuff a name into every injection. */
const MAX_SKILLS_PER_DAY = 100

/** Bound on the pending `skill`-call id list (see ActivityState.skillCalls). */
const MAX_PENDING_SKILL_CALLS = 100

export interface ActivityState {
  days: Record<string, ActivityDay>
  /** The route in force (the last `request/header`'s config wins) — prices each settlement. */
  model?: string
  provider?: string
  /** The open step's start instant (armed by `step/start`, cleared by `step/end`). */
  stepStart?: number
  /** Pending `skill`-tool call ids (armed by `tool/call`, consumed by the pairing `tool/result`):
   * the wrapper match alone is not trusted, or a `read` of source text quoting
   * `<skill_content name="…">` would book a load. Bounded at {@link MAX_PENDING_SKILL_CALLS}. */
  skillCalls?: string[]
}

const activitySkillSchema = z.object({
  n: z.number().int().nonnegative(),
  last: z.number(),
}).strict()

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: costUsageSchema.optional(),
  skills: z.record(z.string(), activitySkillSchema).optional(),
}).strict()
/** Validate the wire payload before it leaves the host (strict: no drift). */
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

/** The persisted fold-state schema — validated before a checkpoint row seeds a fold. */
const activityStateSchema = z.object({
  days: z.record(z.string(), activityDaySchema),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
  skillCalls: z.array(z.string()).optional(),
}) as unknown as z.ZodType<ActivityState>

/** One durable usage object's billed buckets, or null when NO bucket is readable (a settlement
 * that carried no usage still counts its request without fabricating tokens). Buckets pass the
 * shared sanitizer {@link tokenCountOf}: fractions round, negatives clamp. */
function billedBucketsOf(value: unknown): BilledUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as UsageLike
  const input = tokenCountOf(usage.inputTokens)
  const cacheRead = tokenCountOf(usage.cacheReadTokens)
  const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
  const output = tokenCountOf(usage.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return { uncached: input ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, output: output ?? 0 }
}

/** Write one day entry back into the ledger under the retention cap. A dynamic `delete` per
 * evicted key would deopt the record into dictionary mode, so the kept suffix rebuilds. */
function withDayEntry(state: ActivityState, key: string, entry: ActivityDay): ActivityState {
  let days = { ...state.days, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  return { ...state, days }
}

/** Book one skill load against its day: the tally grows and `last` takes the max, so a disordered
 * replay never walks it back. A day at the name cap keeps its booked names and drops the newcomer. */
function bookSkillLoad(state: ActivityState, name: string, time: number): ActivityState {
  const key = dayKeyOf(time)
  if (key === null) return state
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  const existing = prev?.skills?.[name]
  if (existing === undefined && prev?.skills !== undefined && Object.keys(prev.skills).length >= MAX_SKILLS_PER_DAY) return state
  const skills = {
    ...prev?.skills,
    [name]: { n: (existing?.n ?? 0) + 1, last: existing === undefined ? time : Math.max(existing.last, time) },
  }
  const entry: ActivityDay = {
    tokens: prev?.tokens ?? 0,
    requests: prev?.requests ?? 0,
    ...(prev?.cost !== undefined ? { cost: prev.cost } : {}),
    skills,
  }
  return withDayEntry(state, key, entry)
}

/** The skill name a `user/message` (or `developer/message`) load gesture carries: a user-explicit
 * `/name` invocation's durable `skill-invocation` envelope. Anything else reads as no load. */
function invokedSkillOf(event: SessionEvent): string {
  const data = event.data as { source?: unknown; message?: unknown } | null | undefined
  const carrier = event.type === 'developer/message' ? data?.message : data
  const source = carrier !== null && typeof carrier === 'object'
    ? (carrier as { source?: unknown }).source
    : undefined
  if (source === null || typeof source !== 'object') return ''
  const rec = source as { kind?: unknown; name?: unknown }
  return rec.kind === 'skill-invocation' && typeof rec.name === 'string' ? rec.name : ''
}

function toolResultCallIdOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const rec = message as { toolCallId?: unknown; source?: unknown }
  if (typeof rec.toolCallId === 'string' && rec.toolCallId !== '') return rec.toolCallId
  const source = rec.source
  if (source === null || typeof source !== 'object') return null
  const callId = (source as { callId?: unknown }).callId
  return typeof callId === 'string' && callId !== '' ? callId : null
}
/** Fold one committed event into the ledger. Everything else returns the state reference
 * unchanged, as does a settlement with no attributable instant; the next state is a copy along
 * the mutated path only — the persisted previous state is never mutated in place. */
export function applyActivity(state: ActivityState, event: SessionEvent): ActivityState {
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } | null } | null } | undefined
    const config = data?.header?.config
    if (config === null || typeof config !== 'object') return state
    const model = typeof config.model === 'string' ? config.model : undefined
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    const nextModel = model !== undefined ? model : state.model
    const nextProvider = provider !== undefined ? provider : state.provider
    if (nextModel === state.model && nextProvider === state.provider) return state
    return {
      ...state,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    }
  }
  if (event.type === 'step/start') {
    if (!Number.isFinite(event.time)) return state
    return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
  }
  if (event.type === 'step/end') {
    if (state.stepStart === undefined) return state
    // DELETE the field — assigning `undefined` would break the plain-JSON precondition.
    const next = { ...state }
    delete next.stepStart
    return next
  }
  if (event.type === 'session/end-seed') {
    // The tagged fork/seed boundary: settlements before it are the inherited parent-log prefix,
    // already booked to the session it forked from, so the ledger resets. `stepStart` dies with
    // the cut, so an armed slot from the inherited tail cannot attribute the child's first settlement to a parent day.
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited !== true) return state
    return { days: {} }
  }
  if (event.type === 'user/message' || event.type === 'developer/message') {
    const name = invokedSkillOf(event)
    return name === '' ? state : bookSkillLoad(state, name, event.time)
  }
  if (event.type === 'tool/call') {
    // Arm the pairing claim for a `skill`-tool dispatch; the wrapper match in the result is
    // trusted only under this pairing (see ActivityState.skillCalls).
    const data = event.data as { callId?: unknown; name?: unknown } | null | undefined
    const callId = data?.callId
    if (data?.name !== 'skill' || typeof callId !== 'string' || callId === '') return state
    const pending = state.skillCalls ?? []
    if (pending.includes(callId)) return state
    return { ...state, skillCalls: [...pending, callId].slice(-MAX_PENDING_SKILL_CALLS) }
  }
  if (event.type === 'tool/result') {
    // The model-initiated load path: the `skill` tool's result renders the instructions behind
    // the `<skill_content name="…">` wrapper. An unpaired result books nothing; the claim consumes once either way.
    const message = (event.data as { message?: unknown } | null | undefined)?.message
    const callId = toolResultCallIdOf(message)
    const pending = state.skillCalls
    if (callId === null || pending === undefined || !pending.includes(callId)) return state
    const skillCalls = pending.filter(id => id !== callId)
    const next: ActivityState = { ...state }
    // DELETE the drained field — an undefined-valued property would break the plain-JSON state.
    if (skillCalls.length > 0) next.skillCalls = skillCalls
    else delete next.skillCalls
    const name = skillNameOf(message)
    return name === '' ? next : bookSkillLoad(next, name, event.time)
  }
  if (event.type !== 'assistant/message') return state
  // Attribute the settlement to the open step's initiation instant, falling back to its own; the
  // slot stays armed, so a second settlement of the same step still reads it.
  const initiated = state.stepStart !== undefined ? state.stepStart : event.time
  const key = dayKeyOf(initiated)
  if (key === null) return state
  const data = event.data as { usage?: unknown } | undefined
  const buckets = billedBucketsOf(data?.usage)
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  // A settlement prices only when a model is in force: a model-less settlement still counts its
  // tokens and request, never a fabricated fee.
  let cost = prev?.cost
  if (buckets !== null && state.model !== undefined) {
    cost = addBilledUsage(cost, state.provider ?? '', state.model, initiated, buckets)
  }
  const entry = {
    tokens: (prev === undefined ? 0 : prev.tokens)
      + (buckets === null ? 0 : buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output),
    requests: (prev === undefined ? 0 : prev.requests) + 1,
    ...(cost !== undefined ? { cost } : {}),
    // The day's skill tallies ride the entry by reference; every mutation clones along its path.
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
  }
  return withDayEntry(state, key, entry)
}

/** The daily-activity projection unit, registered alongside the timeline and headers units
 * (host/index.ts). `stateVersion` 4: the day entry gained the skill table, which later events
 * cannot backfill for already-folded days, so cached rows read version-stale on upgrade and the
 * Context Insights warm-up cold-refolds them. On the wire the field is additive-optional. */
export function createContextActivityDefinition(): ProjectionDefinition<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event),
    // The view copies the ledger AND each entry's nested records so the registry, the cache writer, and the
    // wire can never mutate the fold's own record; every mutation above clones along its path.
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, {
          ...v,
          // Conditional spread: an `undefined`-valued property fails the whole lossless-JSON push.
          ...(v.cost !== undefined ? { cost: copyCostUsage(v.cost) } : {}),
          ...(v.skills !== undefined
            ? { skills: Object.fromEntries(Object.entries(v.skills).map(([n, t]) => [n, { ...t }])) }
            : {}),
        }])),
      }),
    },
    stateVersion: 4,
  }
}
