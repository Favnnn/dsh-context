/**
 * The fold's served values — the slim wire head, the on-demand detail payload, and the inline view.
 * Every field is a copy, so a served value never aliases persisted state.
 */

import type { ContextTimelineDetail, Snapshot, ToolTimingTotals } from '../shared/types'
import { copyCostUsage } from './foldMetering'
import type { FoldBounds } from './config'
import type { TimelineState } from './foldState'

/** Served value fields are COPIES — the served value must never alias persisted state. Optional scalars use
 * conditional spread, because one `undefined`-valued property can fail the whole lossless-JSON push. */
function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  // Provider-anchored occupancy is NOT folded here: the Client reads token-meter's own `contextPressure` key for it.
  const result: Snapshot = {
    ok: true,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    ...(state.maxOutputTokens !== undefined ? { maxOutputTokens: state.maxOutputTokens } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      skill: state.sums.skill,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
    // Calls still in flight (no result yet) and results compacted or pruned out of the surface are both excluded.
    // A skill-tool load reclassifies its node into the `skill` bucket but keeps its tool identity, so it still counts.
    toolCalls: state.surface.reduce((n, node) => node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined) ? n + 1 : n, 0),
    humanInputs: state.humanInputs ?? 0,
    answers: state.answers ?? 0,
    ...(state.lastUser !== undefined ? { lastUser: state.lastUser } : {}),
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  // The cost totals ride the wire as COPIES, like the collections.
  if (state.cost !== undefined) {
    result.cost = copyCostUsage(state.cost)
  }
  // The timing totals ride the wire as COPIES too (per-name rows included).
  if (state.timing !== undefined) {
    const tools: Record<string, ToolTimingTotals> = {}
    for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] }
    result.timing = { ...state.timing, tools }
  }
  // The browser resolves the prompt in force at any step from these and fetches its TEXT on demand from the event.
  if (state.systems !== undefined && state.systems.length > 0) {
    result.systems = state.systems.map(n => ({ ...n }))
  }
  return result
}

/** Shared verbatim by the inline wire view (channel-less hosts) and the on-demand detail payload (host/detail.ts). */
function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
    spans: state.spans.map(s => ({ ...s })),
  }
  // Injections land on the surface FIRST, so in a long session the plain tail would drop their identity while
  // their tokens keep counting (sums cover the full surface), leaving the browser with a token sum and no
  // listable items; skill content behaves the same way (the digest is injected at session start, loads pile up
  // early). Pin both categories into the served list.
  // The overflow slice precedes the tail by position, so the concatenation stays seq-ordered.
  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(n => n.cat === 'inject' || n.cat === 'skill')
  result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  result.droppedNodes = overflowCount - pinned.length
  // Both floors let the client mark a picked step's reconstruction approximate instead of silently under-showing it.
  if (result.droppedNodes > 0) {
    let floor = 0
    for (const n of overflow) if (n.cat !== 'inject' && n.cat !== 'skill') floor = Math.max(floor, n.seq)
    result.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) result.archiveFloor = state.archiveFloor

  // Attach each event to the requests around it: `turn`/`step` name the first request logged after the event,
  // `fromTurn`/`fromStep` the request before it. Both lists stay seq-sorted, so one pointer walk suffices.
  const requests = result.requests
  const events = result.events
  let ri = 0
  for (const ev of events) {
    while (ri < requests.length && requests[ri].seq <= ev.seq) ri++
    // .at() keeps the past-the-end case visible to the type system.
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

/** The split generation's SLIM wire head: the envelope scalars, the precomputed count figures, the newest
 * request's billing summary, and the detail revision marker — small enough to ride every delivery channel whole. */
export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  // Over the RETAINED records, the same set the detail serves.
  const turns = new Set<number>()
  for (const r of state.requests) turns.add(r.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // Distinct names among the skill-tagged inject events; the catalog digest rides an untagged event, so it never lands here.
  const skills = new Set<string>()
  for (const e of state.events) {
    if (e.kind === 'inject') injects++
    else if (e.kind === 'compaction') compactions++
    else if (e.kind === 'prune') prunes++
    if (e.sub === 'skill' && typeof e.name === 'string' && e.name !== '') skills.add(e.name)
  }
  result.counts = { turns: turns.size, steps: state.requests.length, injects, compactions, prunes, skills: skills.size }
  const last = state.requests.at(-1)
  if (last !== undefined) {
    result.last = { seq: last.seq, total: last.total, ...(typeof last.prompt === 'number' ? { prompt: last.prompt } : {}) }
  }
  result.detailRev = state.detailRev ?? 0
  return result
}

/** The heavy collections, the slim head at the SAME cut, and the revision marker the head carries. */
export function buildTimelineDetail(state: TimelineState, bounds: FoldBounds): ContextTimelineDetail {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state), ...detailCollectionsOf(state, bounds) }
}

/** The INLINE projection wire view for channel-less hosts: the head scalars with the detail collections in place. */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  return { ...headFieldsOf(state), ...detailCollectionsOf(state, bounds) }
}
