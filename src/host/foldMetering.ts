/**
 * The fold's untrusted-input metering: provider-reported usage normalized to billed counts, plus the
 * accumulators that write the state's cumulative cost, decode, and per-tool timing tallies.
 */

import type { CostBucketTotals, CostModelUsage, SessionCostUsage, TimingTotals, ToolTimingTotals } from '../shared/types'
import { isDeepSeekProvider } from '../shared/providers'
import type { DecodeKind } from './logShapes'
import type { TimelineState } from './foldState'

/** The durable usage object, as far as the fold reads it — every bucket is re-proved by `tokenCountOf`, never trusted. */
export interface UsageLike {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
}

/** One usage object's buckets, normalized to billed counts (see {@link tokenCountOf}). The cost
 * ledger accumulates these into the same bucket vocabulary it serves, so they share one shape. */
export type BilledUsage = CostBucketTotals

/**
 * One provider-reported usage bucket as a billed count, or null when the field carries no readable number. Fractions
 * round and negatives clamp to 0: a gateway reporting `cached_tokens > prompt_tokens` drives the disjoint uncached
 * figure below zero, and one raw figure in the state would fail the wire/state schemas' `.int().nonnegative()` gates
 * on every later delivery, permanently freezing the projection feed for the session. NaN, infinities, and non-numeric
 * values read as absent.
 *
 * Exported so the activity unit re-proves the same buckets with the same sanitizer.
 */
export function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

/** DeepSeek's official peak windows: UTC 01:00-04:00 and 06:00-10:00, Monday through Friday; all other hours bill at half price. */
export function isPeakUtc(time: number): boolean {
  const at = new Date(time)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

/** Clones along the mutated path only — the untouched branch stays shared with the persisted previous state, which the
 * apply contract never mutates in place. Buckets arrive sanitized, so the totals stay at the schemas' non-negative safe
 * integers. The timeline fold and the activity ledger price by this ONE walk, so their records share one shape. */
export function addBilledUsage(
  prev: SessionCostUsage | undefined,
  provider: string,
  model: string,
  time: number,
  usage: BilledUsage,
): SessionCostUsage {
  const period = isDeepSeekProvider(provider) && !isPeakUtc(time) ? 'off' : 'peak'
  const models = prev?.[provider] ?? {}
  const periods = models[model] ?? {}
  const b = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextPeriods: CostModelUsage = { ...periods }
  nextPeriods[period] = {
    uncached: b.uncached + usage.uncached,
    cacheRead: b.cacheRead + usage.cacheRead,
    cacheWrite: b.cacheWrite + usage.cacheWrite,
    output: b.output + usage.output,
  }
  const nextModels: Record<string, CostModelUsage> = { ...models, [model]: nextPeriods }
  return { ...(prev ?? {}), [provider]: nextModels }
}

/** The mirror of {@link addBilledUsage}: a served value must never alias the persisted record it was folded
 * from, so every level of the ledger is copied. */
export function copyCostUsage(cost: SessionCostUsage): SessionCostUsage {
  const copy: SessionCostUsage = {}
  for (const provider in cost) {
    const models: Record<string, CostModelUsage> = {}
    for (const model in cost[provider]) {
      const periods = cost[provider][model]
      const modelCopy: CostModelUsage = {}
      if (periods.peak !== undefined) modelCopy.peak = { ...periods.peak }
      if (periods.off !== undefined) modelCopy.off = { ...periods.off }
      models[model] = modelCopy
    }
    copy[provider] = models
  }
  return copy
}

/** The key is the request envelope's (provider, model) face; a request without a model has nothing to price. */
export function accumulateCost(st: TimelineState, time: number, usage: BilledUsage): void {
  const model = st.model
  if (model === undefined) return
  st.cost = addBilledUsage(st.cost, st.provider ?? '', model, time, usage)
}

/** The busiest 16 tool names are kept. */
const TOOL_TIMING_CAP = 16

/** The decode buckets of the generation split, in card order. */
export const DECODE_KINDS: readonly DecodeKind[] = ['reasoning', 'text', 'toolarg']

export function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/** Created on first use and CLONED on every later `ensure()`: the persisted previous state is never written in place. */
export function ensureTiming(st: TimelineState): TimingTotals {
  if (st.timing === undefined) {
    st.timing = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  }
  return st.timing
}

/** The TimingTotals fields each decode bucket's span and count land in. */
const DECODE_FIELDS: Record<DecodeKind, { ms: 'reasoningMs' | 'textMs' | 'toolArgMs'; n: 'reasoningBlocks' | 'textBlocks' | 'toolArgBlocks' }> = {
  reasoning: { ms: 'reasoningMs', n: 'reasoningBlocks' },
  text: { ms: 'textMs', n: 'textBlocks' },
  toolarg: { ms: 'toolArgMs', n: 'toolArgBlocks' },
}

/** A zero span or count stays ABSENT, so a pre-split-shaped state gains no dead properties; the card reads absence as 0. */
export function addDecode(timing: TimingTotals, kind: DecodeKind, ms: number, blocks: number): void {
  const field = DECODE_FIELDS[kind]
  if (ms > 0) timing[field.ms] = (timing[field.ms] ?? 0) + ms
  if (blocks > 0) timing[field.n] = (timing[field.n] ?? 0) + blocks
}

/** A new name beyond the cap evicts the smallest tally, so the state stays bounded even over a hostile log of unique names. */
export function bumpToolTotals(timing: TimingTotals, name: string, ms: number): void {
  // `__proto__` is the one key that assigns the prototype instead of a row: the tally would be lost, the cap would
  // never see it, and `foldWire`'s `for...in` would then copy the inherited `calls`/`ms` as `{}` — failing the strict
  // wire schema, which throws inside the registry's uncontained drive and stalls this unit's push feed for good. The
  // client boundary skips the same name.
  if (name === '__proto__') return
  // hasOwn, not an index check: a missing key IS possible at runtime (a name outside the persisted tally).
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      let minKey = ''
      let minMs = Infinity
      for (const k in timing.tools) {
        if (timing.tools[k].ms < minMs) {
          minMs = timing.tools[k].ms
          minKey = k
        }
      }
      const kept: Record<string, ToolTimingTotals> = {}
      for (const k in timing.tools) {
        if (k !== minKey) kept[k] = timing.tools[k]
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const cur = timing.tools[name]
  timing.tools[name] = { calls: cur.calls + 1, ms: cur.ms + ms }
}
