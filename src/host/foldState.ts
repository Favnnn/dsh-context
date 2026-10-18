/**
 * The timeline fold's persisted state shape and the event envelope it consumes, plus the state's
 * construction and retention bounds — the plain JSON the projection cache checkpoints. `fold.ts`
 * owns the reducer that writes it.
 */

import type { Category, ContextEventRecord, FileOpRecord, RequestRecord, SessionCostUsage, SurfaceNode, SystemPromptNode, TimingSpan, TimingTotals } from '../shared/types'
import type { FoldBounds } from './config'

/** The runtime event envelope this fold consumes. The core `SessionEvent` union carries only core event types;
 * plugin-merged vocabulary (the `compaction/*` family, declared by `dsh-compaction`) is absent, and the fold must
 * not depend on those packages — so it widens to this structural envelope. */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  sums: Record<Category, number>
  systemTokens: number
  /** The live system-prompt nodes, oldest first. `systemTokens` is the LAST entry with tokens > 0 (the harness's
   * own "last nonempty surviving system" rule), so an empty dormant node keeps its position without clearing the
   * prompt. Bounded by SYSTEM_NODES_MAX. Absent on rows folded before this field existed; the client then falls
   * back to the header epoch's own envelope figure. */
  systems?: SystemPromptNode[]
  toolsTokens: number
  /** The projection cache requires plain JSON: a property whose value is `undefined` makes the whole checkpoint
   * unserializable, failing EVERY cache write for the session — including the `title` row that powers the session
   * list after a restart. Optional fields therefore stay absent until a value is known, never `undefined`-valued. */
  model?: string
  provider?: string
  lastModel?: string
  contextWindow?: number
  /** The newest `request/header` envelope's routed output cap (dsh materializes the adapter default
   * into it). Last-wins: a header omitting the cap clears it. */
  maxOutputTokens?: number
  requests: RequestRecord[]
  /** The number of turn runs in `requests` (a run = consecutive records sharing one `turn`). Maintained
   * incrementally at the single append site and recomputed when a trim replaces the array, so the retention
   * trim's cap check stays O(1) per event. Absent on rows folded before the field existed. */
  turnRuns?: number
  events: ContextEventRecord[]
  /** Recently removed surface nodes (stamped COPIES carrying `gone`), in removal order. Bounded two ways in
   * trimState: capped to `maxArchiveNodes`, and pruned to removals after the oldest retained request. */
  archived: SurfaceNode[]
  /** Cumulative billed-token totals per (provider, model), split into pricing periods for DeepSeek. Never trimmed, so
   * the estimate covers the COMPLETE session log. */
  cost?: SessionCostUsage
  /** Whole-session human-input tally (see Snapshot.humanInputs); never trimmed, like `cost`. */
  humanInputs?: number
  /** Whole-session answers tally (see Snapshot.answers); never trimmed, like `humanInputs`. */
  answers?: number
  /** The user's newest own message as a bounded one-line preview. Last-wins: a text-less input (images only) keeps the previous line. */
  lastUser?: string
  archiveFloor?: number
  /** Bumped by every fold that mutates the request records, context events, live surface, or removed-node
   * archive; the slim wire head carries it so an open tab knows its fetched detail went stale. */
  detailRev?: number
  /** Whole-session timing totals (see TimingTotals), running sums over the COMPLETE session log like `cost`. */
  timing?: TimingTotals
  /** The open step's start instant, armed by `step/start` and consumed by the `assistant/message` (TTFT/generation
   * split) and `step/end` (wall time) that follow. One slot, not a map: steps are sequential in the log, so the
   * newest `step/start` is the one those events close — a hostile interleaved log degrades to skipped durations. */
  stepStart?: {
    time: number
    firstToken?: number
  }
  /** The open step's CLOSED user-wait intervals (real log instants), pushed replace-style as each wait settles: an
   * approval decision, or an `ask_user_question` call's whole tool window. `step/end` subtracts their clamped
   * union from the step window to price the request's `activeMs`, then deletes the slot. */
  stepWaits?: { start: number; end: number }[]
  /** The open step's PENDING approval waits (request id → its `approval/asked` instant), disarmed by the matching
   * `approval/decided`. A crash mid-decision leaves the pair dangling, so `step/end` closes the survivors at its
   * own instant. Deleted at `step/start` (a superseded step's leftovers) and `step/end`. */
  stepApprovals?: Record<string, number>
  /** The seq of the request record committed by the open step's `assistant/message` — the back-pointer `step/end`
   * stamps `activeMs` onto. Nothing pushes between a step's message and its end, so the record is the requests
   * tail and the stamp is an O(1) tail write guarded by this seq. */
  stepRequestSeq?: number
  /** The timing strip's painted spans: every completed step's time slices in log order, stamped with their REAL
   * instants — the TTFT wait, the decode blocks in stream order, the tool-run windows, and the in-step residue.
   * Idle time BETWEEN steps carries no span. Bounded by TIMING_SPANS_MAX (newest tail kept). */
  spans: TimingSpan[]
  /** The open step's accumulated painted spans; `step/end` clamps them into the step window, de-overlaps
   * first-wins (parallel runs paint their union), fills the holes with the residue kind, and flushes the tiling
   * into `spans`. Deleted at the flush (the plain-JSON precondition). */
  stepSpans?: TimingSpan[]
  /** Tool callId → the call's name, start instant, and raw arguments, armed by `tool/call` and DELETED when its
   * `tool/result` folds in — the map stays at pending-call size instead of growing for the session's lifetime. */
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  /** Seq list of the surface nodes the next replacement will shadow, armed by the metering event
   * (`compaction/summary` | `compaction/prune`) and consumed by the replacement that must follow it
   * synchronously. The producer's shadow price covers exactly these seqs, which can differ from the
   * replacement's declared range (pruned replacement nodes keep their own seqs, beyond the range end). */
  pendingShadowedSeqs?: number[]
  /** The seq of the `compaction/prune` event that armed `pendingShadowedSeqs`. The shadowed path rewrites that
   * event's `tokens` from the gross shadow price to the NET freed amount, so the row matches the drop the trend chart shows. */
  pendingShadowEventSeq?: number
  /** The fold-derived file-operation log: one record per executed file op, bounded by `maxFileOps`; the trim stamps `fileOpsFloor`. */
  fileOps: FileOpRecord[]
  /** The newest dropped op's seq (the card's coverage floor for the served op log). */
  fileOpsFloor?: number
  /** Nested Code-Mode ops buffered by their top run_code call id until the parent's result folds (the dispatch
   * events land BEFORE it). Bounded by PENDING_CODE_OPS_MAX, so a hostile log that never settles a run_code cannot grow it. */
  pendingCodeOps?: Record<string, FileOpRecord[]>
}

export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i].turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

export function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

export function trimState(st: TimelineState, bounds: FoldBounds): void {
  // Trim by WHOLE turn-runs as soon as the run count crosses the cap —
  // not only when the raw step count does — so the state stays
  // deterministically at the newest ~maxKeptTurns turns (a threshold-only
  // policy would oscillate: trim to 1200, regrow to 1500, trim again). The
  // run count is the incremental `turnRuns` ledger; a row restored from cache before the field existed recomputes it once here.
  st.turnRuns = st.turnRuns ?? countTurnRuns(st.requests)
  if (st.turnRuns > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
    st.turnRuns = countTurnRuns(st.requests)
  }
  // Pathological many-step turns: hard step backstop after the turn trim.
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
    st.turnRuns = countTurnRuns(st.requests)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  if (st.spans.length > TIMING_SPANS_MAX) st.spans = st.spans.slice(-TIMING_SPANS_MAX)
  // The newest dropped op's seq becomes the served op log's coverage floor.
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  if (st.archived.length > 0) {
    let drop = 0
    // The entries leave in removal order, so the last dropped one's `gone` is the newest dropped seq.
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

/** A count cap, newest tail kept; at ~6-8 spans per step it covers a few hundred recent steps, far past the strip's pixel resolution. */
const TIMING_SPANS_MAX = 2_000

export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    spans: [],
  }
}
