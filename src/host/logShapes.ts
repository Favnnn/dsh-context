/**
 * Shape-driven readers over the durable session-event vocabulary — the ONE place the plugin's
 * log spellings meet. The supported range (dsh 0.1.7-rc.2+, session format V4) speaks ONE
 * dialect: `system/message` surface nodes, packed assistant stream records, `SurfaceOp
 * { startSeq, endSeq }`.
 *
 * Readers stay total over untrusted input: the projection registry drives the fold with no error
 * boundary, so one throw stalls that unit's push feed and the browser waits on "loading" forever.
 * The fold reads SHAPES, never a detected harness version; older logs the harness cannot migrate
 * to V4 are refused, never served raw.
 *
 * @module dsh-context/host/log-shapes
 */

/** Whether a raw stream chunk carries a token delta; mirrors dsh-llm's `isTokenDelta`. */
export function isTokenChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
}

/** The decode bucket a stream's `block-start.blockType` names; undefined for an unknown marker. */
export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

export function decodeKindOfBlock(blockType: unknown): DecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

export interface DecodeTally {
  spans: Record<DecodeKind, number>
  blocks: Record<DecodeKind, number>
}

/** Decode spans and `block-start` counts inside one embedded assistant stream, tiling
 * [first block-start, endTime]: each marker owns the interval up to the next one, the last one up
 * to `endTime`; total over untrusted input. */
export function decodeTallyOfStream(stream: unknown, endTime: number): DecodeTally {
  const tally: DecodeTally = { spans: { reasoning: 0, text: 0, toolarg: 0 }, blocks: { reasoning: 0, text: 0, toolarg: 0 } }
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return tally
  let kind: DecodeKind | undefined
  let since = 0
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (kind !== undefined) tally.spans[kind] += Math.max(0, time - since)
    kind = decodeKindOfBlock(chunk.blockType)
    if (kind !== undefined) tally.blocks[kind] += 1
    since = time
  }
  if (kind !== undefined) tally.spans[kind] += Math.max(0, endTime - since)
  return tally
}

export interface DecodeSpan {
  kind: DecodeKind
  start: number
  end: number
}

/** The ORDERED decode spans of one embedded assistant stream — the same ownership rule as
 * {@link decodeTallyOfStream}, keeping the sequence because the timing strip paints in stream
 * order; an unknown `blockType` leaves its interval unspanned for the caller's residue fill. */
export function decodeSpansOfStream(stream: unknown, endTime: number): DecodeSpan[] {
  const spans: DecodeSpan[] = []
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return spans
  let kind: DecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind !== undefined && to > since) spans.push({ kind, start: since, end: to })
  }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    close(time)
    kind = decodeKindOfBlock(chunk.blockType)
    since = time
  }
  close(endTime)
  return spans
}

/** The first token's instant inside one PACKED delta run (`text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks`): the run's base time plus the accumulated inter-member deltas at the first
 * qualifying member. Mirrors dsh-llm's `runFirstTokenTime`; a non-finite delta yields undefined. */
function runFirstTokenTime(record: Record<string, unknown>): number | undefined {
  const time0 = record.time0
  if (typeof time0 !== 'number' || !Number.isFinite(time0)) return undefined
  if (record.type === 'tool-call-chunks' && record.name !== undefined) return time0
  const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
  if (!Array.isArray(fragments)) return undefined
  const dt: readonly unknown[] = Array.isArray(record.dt) ? record.dt as unknown[] : []
  let time = time0
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const step = dt[index - 1]
      if (typeof step !== 'number' || !Number.isFinite(step)) return undefined
      time += step
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

/** The first token's instant inside an embedded assistant stream
 * (`assistant/message.data.stream`, `assistant/attempt.data.stream`), or undefined when it
 * carries no token; mirrors dsh-llm's `assistantStreamFirstTokenTime`. */
export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type === 'chunk') {
      const time = r.time
      if (typeof time === 'number' && Number.isFinite(time) && isTokenChunk(r.chunk)) return time
      continue
    }
    const time = runFirstTokenTime(r)
    if (time !== undefined) return time
  }
  return undefined
}

/** The inclusive surface range a replacement op covers, or null for `append` and any
 * unrecognized/hostile op (which the fold treats as an append). */
export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const { startSeq: start, endSeq: end } = op
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
