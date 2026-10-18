/**
 * The `contextHeaders` session projection unit — the request-header EPOCH METADATA behind the
 * timeline's envelope figures.
 *
 * The epoch CONTENT (full system prompt, full tool schemas) deliberately does NOT ride the
 * projection value: projections are served whole in every `session.list` row, baseline, push
 * frame, and change notification, so content here would be multiplied by sessions × epochs. The
 * client fetches one epoch's `request/header` on demand through the session history.
 *
 * `stateVersion` stays 1 by decision (the #37 regression): a bump invalidates every cached row
 * and, for an idle session with no projection refresh channel, orphans the key until it goes
 * live. The state therefore still ACCEPTS the v1 content-bearing record shape, and the view
 * normalizes both generations to the metadata-only wire form.
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateToolSchema } from './pricing'
import { estimateSystemTokens } from '../shared/estimate'

const HEADERS_MAX = 50

/** One stored tool: v1 rows carried the producer description and raw schema; later folds append metadata-only. */
interface StoredHeaderTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** One stored epoch: v1 rows carried `system`; later folds carry `systemTokens`. */
interface StoredHeaderRecord {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredHeaderTool[]
}

export interface HeadersState {
  headers: StoredHeaderRecord[]
}

/** The persisted-state schemas: the superset of both record generations, so a cached v1 row (content-bearing) still seeds a fold. */
const storedToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  plugin: z.string().optional(),
  schema: z.unknown().optional(),
}).strict()

const storedEpochSchema = z.object({
  seq: z.number(),
  time: z.number(),
  system: z.string().optional(),
  systemTokens: z.number().int().nonnegative().optional(),
  tools: z.array(storedToolSchema),
}).strict()

const contextHeadersStateSchema = z.object({
  headers: z.array(storedEpochSchema),
}).strict() as unknown as z.ZodType<HeadersState>

const headerToolWireSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  plugin: z.string().optional(),
}).strict()

export const contextHeadersSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    // Absent when the epoch logged no system prompt; sizes the section pre-fetch.
    systemTokens: z.number().int().nonnegative().optional(),
    tools: z.array(headerToolWireSchema),
  }).strict()),
}).strict() as unknown as z.ZodType<ContextHeaders>

function recordOf(event: SessionEvent): StoredHeaderRecord | null {
  if (event.type !== 'request/header') return null
  // This unit has no try/catch, so an impossible shape must degrade to "not an epoch" instead of
  // throwing out of the registry's drive loop.
  const rawHeader = (event.data as { header?: unknown } | undefined)?.header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  // A supported epoch header never carries a system prompt (`EpochHeader.system` is `never`), so
  // epochs fold metadata-only; the stored `system` field exists for cached v1 rows.
  const header = rawHeader as { tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: StoredHeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): StoredHeaderTool => {
      // A null or primitive entry degrades to an unnamed, JSON-priced tool instead of throwing.
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; plugin?: unknown }
      const entry: StoredHeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
      }
      // Kept verbatim so the view-time resolver never overrides an attribution the producer
      // wrote; no supported-baseline path writes one (ToolSchema has no plugin field).
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  return record
}

/**
 * The context-headers projection unit, registered alongside the timeline unit (host/index.ts).
 * @param resolve - best-effort tool-to-plugin attribution (see toolSources.ts); fills a missing
 * `plugin` at view time so epochs folded without attribution still render a tag.
 */
export function createContextHeadersDefinition(
  resolve?: (name: string) => string | undefined,
): ProjectionDefinition<'contextHeaders', HeadersState> {
  // The view normalizes both stored generations to the metadata-only wire shape: legacy v1
  // epochs are stripped of their content here (the system text is priced once per read).
  const view = (state: HeadersState): ContextHeaders => ({
    headers: state.headers.map((h): HeaderRecord => {
      const record: HeaderRecord = {
        seq: h.seq,
        time: h.time,
        tools: h.tools.map((t): HeaderTool => {
          const entry: HeaderTool = { name: t.name, tokens: t.tokens }
          const plugin = t.plugin ?? (resolve !== undefined ? resolve(t.name) : undefined)
          if (plugin !== undefined) entry.plugin = plugin
          return entry
        }),
      }
      const systemTokens = h.systemTokens
        ?? (typeof h.system === 'string' && h.system !== '' ? estimateSystemTokens(h.system) : undefined)
      if (systemTokens !== undefined) record.systemTokens = systemTokens
      return record
    }),
  })
  const definition: ProjectionDefinition<'contextHeaders', HeadersState> = {
    key: 'contextHeaders',
    stateSchema: contextHeadersStateSchema,
    wire: { viewSchema: contextHeadersSchema, view },
    init: (): HeadersState => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const record = recordOf(event)
      if (record === null) return state
      // The agent loop suppresses unchanged headers; this guards a same-epoch replay.
      const last = state.headers.at(-1)
      if (last !== undefined && last.seq === record.seq) return state
      const headers = [...state.headers, record]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    // Pinned at 1 on purpose (see the module header's read-compat note).
    stateVersion: 1,
  }
  return definition
}
