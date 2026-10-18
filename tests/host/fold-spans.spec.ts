// The timing strip's span fold (src/host/fold.ts): every completed step flushes its painted time slices — the TTFT wait, the decode blocks
// in stream order, the tool-run windows, and the in-step residue — into the persisted `spans` collection the client packs gapless by
// duration share (IDLE time between steps carries no span). No mocks: the real fold runs.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import { assistantMessage, stepEnd, stepStart, toolResult } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

/** One raw `chunk` record of an embedded assistant stream, at an absolute time. */
const chunkRec = (time: number, chunk: unknown): unknown => ({ type: 'chunk', time, chunk })

/** tool/call at an explicit instant (the events helper's clock is shared, so the spans specs pin times raw). */
const toolCallAt = (seq: number, callId: string, time: number): TimelineEvent => ({
  type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
})

describe('spans — the step flush', () => {
  test('a full step tiles gapless: TTFT, the decode blocks in stream order, the tool window, residue fills the holes', () => {
    const stream = [
      chunkRec(200, { type: 'block-start', index: 0, blockType: 'reasoning' }),
      { type: 'reasoning-chunks', time0: 210, index: 0, dt: [], texts: ['think'] },
      chunkRec(700, { type: 'block-start', index: 0, blockType: 'text' }),
      { type: 'text-chunks', time0: 710, index: 1, dt: [], texts: ['answer'] },
      chunkRec(1_200, { type: 'block-start', index: 0, blockType: 'tool-call' }),
      { type: 'tool-call-chunks', time0: 1_210, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ]
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream }),
      toolCallAt(3, 'c1', 2_500),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 3_000 }),
      stepEnd(5, { time: 4_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 200 },
      { kind: 'reasoning', start: 200, end: 700 },
      { kind: 'text', start: 700, end: 1_200 },
      { kind: 'toolarg', start: 1_200, end: 2_000 },
      { kind: 'other', start: 2_000, end: 2_500 },
      { kind: 'tools', start: 2_500, end: 3_000 },
      { kind: 'other', start: 3_000, end: 4_000 },
    ])
    assert.equal(Object.hasOwn(state, 'stepStart'), false, 'step/end consumed the pending slot')
    assert.equal(Object.hasOwn(state, 'stepSpans'), false, '…and the span accumulator (never undefined-valued)')
  })

  test('the decode window opens at the first marker when it beats the token; the wait covers only the silent prefix', () => {
    // The reasoning marker (100) sits BEFORE the first stamped chunk (110):
    // the decode window opens at the marker, so the wait band is the 100ms
    // of true silence and the block owns its whole marker-tiled interval.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 110, index: 0, dt: [], texts: ['x'] },
        ],
      }),
      stepEnd(3, { time: 1_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'reasoning', start: 100, end: 900 },
      { kind: 'other', start: 900, end: 1_000 },
    ])
  })

  test('a redacted reasoning block still paints: the marker tiles its window even though no chunk stamps a token', () => {
    // The provider's durable stream carries the reasoning BLOCK markers but
    // packs no reasoning chunks (the content is redacted): the first token
    // lands on a tool-call fragment at 952. Metering (ttftMs) opens the
    // decode window at the MARKER — anchoring the wait at the token would
    // charge the 588ms the legend's own tally reports to the wait as well, and the rows would double-count it past 100%.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_063,
        stream: [
          chunkRec(364, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          chunkRec(952, { type: 'block-start', index: 1, blockType: 'tool-call' }),
          { type: 'tool-call-chunks', time0: 952, index: 1, dt: [0], id: 'c1', args: ['{', '}'] },
        ],
      }),
      toolCallAt(3, 'c1', 1_064),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 1_095 }),
      stepEnd(5, { time: 1_095 }),
    ])
    assert.equal(state.timing?.ttftMs, 364, 'the wait ends at the first marker, not the first token')
    assert.equal(state.timing?.genMs, 699, 'the generation window opens at the same marker')
    assert.equal(state.timing?.reasoningMs, 588, 'the tally tiles the marker window regardless')
    assert.equal(
      (state.timing?.reasoningMs ?? 0) + (state.timing?.textMs ?? 0) + (state.timing?.toolArgMs ?? 0),
      state.timing?.genMs,
      'the decode buckets partition the generation window exactly — no double count',
    )
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 364 },
      { kind: 'reasoning', start: 364, end: 952 },
      { kind: 'toolarg', start: 952, end: 1_063 },
      { kind: 'other', start: 1_063, end: 1_064 },
      { kind: 'tools', start: 1_064, end: 1_095 },
    ])
  })

  test('blocks stamped wholly past the message instant drop out of the tile', () => {
    // Hostile stream: both markers sit beyond the assistant message's own
    // instant — their claimed intervals assert decode after the message landed, so they paint nothing.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 300,
        stream: [
          chunkRec(100, { type: 'text-delta', text: 'x' }),
          chunkRec(400, { type: 'block-start', index: 0, blockType: 'text' }),
          chunkRec(500, { type: 'block-start', index: 1, blockType: 'reasoning' }),
        ],
      }),
      stepEnd(3, { time: 600 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 600 },
    ])
  })

  test('a marker-less stream leaves the generation window to the residue fill', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_000,
        stream: [chunkRec(100, { type: 'text-delta', text: 'x' })],
      }),
      stepEnd(3, { time: 1_400 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 1_400 },
    ])
  })

  test('an unstamped call paints no model slices — the whole step is residue', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000 }),
      stepEnd(3, { time: 1_400 }),
    ])
    assert.deepEqual(state.spans, [{ kind: 'other', start: 0, end: 1_400 }])
  })

  test('idle time BETWEEN steps carries no span', () => {
    const step = (seq: number, start: number): TimelineEvent[] => [
      stepStart(seq, { time: start }),
      assistantMessage(seq + 1, { time: start + 1_000, stream: [chunkRec(start + 100, { type: 'text-delta', text: 'x' })] }),
      stepEnd(seq + 2, { time: start + 1_400 }),
    ]
    const { state } = driveTimeline([...step(1, 0), ...step(4, 10_000)])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 1_400 },
      // 1_400 → 10_000: the session was idle — nothing paints.
      { kind: 'ttft', start: 10_000, end: 10_100 },
      { kind: 'other', start: 10_100, end: 11_400 },
    ])
  })

  test('parallel tool runs paint their UNION, never double wall time — same-instant and shadowed windows included', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000 }),
      // Three overlapping windows: two identical (one shadows whole), one longer.
      toolCallAt(3, 'c1', 2_000),
      toolCallAt(4, 'c2', 2_000),
      toolCallAt(5, 'c3', 2_000),
      toolResult(6, { callId: 'c1', content: text('ok'), time: 3_000 }),
      toolResult(7, { callId: 'c2', content: text('ok'), time: 3_000 }),
      toolResult(8, { callId: 'c3', content: text('ok'), time: 3_500 }),
      stepEnd(9, { time: 4_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'other', start: 0, end: 2_000 },
      { kind: 'tools', start: 2_000, end: 3_000 },
      { kind: 'tools', start: 3_000, end: 3_500 },
      { kind: 'other', start: 3_500, end: 4_000 },
    ])
    // The totals keep the TRUE per-call sums (3_500ms over 3 calls) — only the strip de-overlaps.
    assert.equal(state.timing?.toolsMs, 1_000 + 1_000 + 1_500)
    assert.equal(state.timing?.toolCalls, 3)
  })

  test('spans clamp into the step window; a window wholly outside drops', () => {
    // A run whose result arrives after the step's end instant (out-of-order log) paints only up to the end…
    const past = driveTimeline([
      stepStart(1, { time: 0 }),
      toolCallAt(2, 'c1', 3_000),
      toolResult(3, { callId: 'c1', content: text('ok'), time: 5_000 }),
      stepEnd(4, { time: 4_000 }),
    ])
    assert.deepEqual(past.state.spans, [
      { kind: 'other', start: 0, end: 3_000 },
      { kind: 'tools', start: 3_000, end: 4_000 },
    ])
    // …and a run stamped wholly BEFORE the step's window paints nothing.
    const before = driveTimeline([
      stepStart(1, { time: 3_000 }),
      toolCallAt(2, 'c1', 100),
      toolResult(3, { callId: 'c1', content: text('ok'), time: 200 }),
      stepEnd(4, { time: 4_000 }),
    ])
    assert.deepEqual(before.state.spans, [{ kind: 'other', start: 3_000, end: 4_000 }])
  })

  test('a zero-width step flushes nothing; an unpaired step/end stays uninteresting', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 5_000 }),
      stepEnd(2, { time: 5_000 }),
    ])
    assert.deepEqual(state.spans, [])
    const bare = driveTimeline([stepEnd(1, { time: 5_000 })])
    assert.deepEqual(bare.state.spans, [])
  })

  test('a tool result folded without an open step prices the totals but paints no span', () => {
    const { state } = driveTimeline([
      toolCallAt(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 2_000 }),
    ])
    assert.equal(state.timing?.toolsMs, 1_000)
    assert.deepEqual(state.spans, [])
  })

  test('a second step/start supersedes the open accumulator — its un-flushed spans die with it', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      // No step/end: the first step's accumulated spans are dropped, not flushed.
      stepStart(3, { time: 10_000 }),
      assistantMessage(4, { time: 11_000, stream: [chunkRec(10_100, { type: 'text-delta', text: 'y' })] }),
      stepEnd(5, { time: 11_400 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 10_000, end: 10_100 },
      { kind: 'other', start: 10_100, end: 11_400 },
    ])
  })

  test('the flush marks the detail revision (open tabs refetch the strip)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      stepEnd(2, { time: 1_000 }),
    ])
    assert.equal(state.detailRev, 1)
  })
})

describe('spans — retention, wire, and schema faces', () => {
  test('the collection keeps the newest tail past the 2_000-span cap', () => {
    // 41 steps × 50 spans each (a 48-marker decode run): 2_050 spans — the
    // cap must drop the oldest step whole. Fewer, denser steps keep the fold cheap enough for a CI runner's 5s test timeout.
    const events: TimelineEvent[] = []
    for (let i = 0; i < 41; i++) {
      const start = i * 10_000
      const stream: unknown[] = [chunkRec(start + 100, { type: 'text-delta', text: 'x' })]
      for (let m = 0; m < 48; m++) {
        stream.push(chunkRec(start + 100 + m * 10, { type: 'block-start', index: 0, blockType: m % 2 === 0 ? 'text' : 'reasoning' }))
      }
      events.push(
        stepStart(i * 3 + 1, { time: start }),
        assistantMessage(i * 3 + 2, { time: start + 1_000, stream }),
        stepEnd(i * 3 + 3, { time: start + 1_400 }),
      )
    }
    const { state } = driveTimeline(events)
    assert.equal(state.spans.length, 2_000)
    assert.deepEqual(state.spans[0], { kind: 'ttft', start: 10_000, end: 10_100 }, 'the oldest step left the window')
    assert.deepEqual(state.spans.at(-1), { kind: 'other', start: 401_000, end: 401_400 })
  })

  test('the inline wire view serves COPIES; the slim head omits the collection whole', () => {
    const events: TimelineEvent[] = [
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      stepEnd(3, { time: 1_400 }),
    ]
    const drive = driveTimeline(events)
    assert.deepEqual(drive.view.spans, drive.state.spans)
    assert.notEqual(drive.view.spans, drive.state.spans, 'the served array never aliases the state')
    assert.notEqual(drive.view.spans?.[0], drive.state.spans[0], '…nor its items')
    // The detail payload (the channel's serve) carries the same copies.
    const detail = buildTimelineDetail(drive.state, resolveBounds({}))
    assert.deepEqual(detail.spans, drive.state.spans)
    assert.notEqual(detail.spans[0], drive.state.spans[0])
    // The slim head (detail-channel deployments) has no spans key at all.
    const slimDef = timelineDef({}, true)
    let slimState = slimDef.init()
    for (const ev of events) slimState = slimDef.apply(slimState, ev)
    assert.equal(Object.hasOwn(slimDef.wire.view(slimState), 'spans'), false)
  })

  test('every intermediate state validates against the state schema; a spans-less state fails it (the v23 gate)', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      stepEnd(3, { time: 1_400 }),
    ])
    for (const state of drive.states) drive.def.stateSchema.parse(structuredClone(state))
    // A row folded before the collection existed has no `spans` key: the
    // required-key schema rejects it, so the projection cache refolds it from the durable log (the stateVersion 22 → 23 bump).
    const stale = structuredClone(drive.state) as unknown as Record<string, unknown>
    delete stale.spans
    assert.throws(() => drive.def.stateSchema.parse(stale))
  })

  test('span-bearing states stay plain JSON', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      toolCallAt(3, 'c1', 1_100),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 1_200 }),
      stepEnd(5, { time: 1_400 }),
      // A step left OPEN mid-accumulation: the intermediate states carry the
      // armed accumulator through the same gate (driveTimeline pins the no-absent-members rule on every one).
      stepStart(6, { time: 2_000 }),
      assistantMessage(7, { time: 3_000, stream: [chunkRec(2_100, { type: 'text-delta', text: 'y' })] }),
    ])
    for (const state of drive.states) assertPlainJson(state)
  })
})
