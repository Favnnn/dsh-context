import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyActivity, contextActivitySchema, createContextActivityDefinition } from '../../src/host/activity'
import { isPeakUtc } from '../../src/host/fold'
import { dayKeyOf } from '../../src/shared/days'

/** Local noon of a day offset from 2026-01-01 — deterministic in every timezone. */
function at(daysFromNewYear: number): number {
  return new Date(2026, 0, 1 + daysFromNewYear, 12).getTime()
}

function assistantMessage(time: number, usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: usage === undefined ? {} : { usage },
  } as never
}

describe('contextActivity unit: shape', () => {
  test('the definition carries the contract fields', () => {
    const def = createContextActivityDefinition()
    assert.equal(def.key, 'contextActivity')
    assert.equal(def.stateVersion, 4, 'the per-day skill table is the fourth shape')
    assert.deepEqual(def.init(), { days: {} })
  })

  test('the wire view passes its schema; the state schema round-trips a folded state', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 3, outputTokens: 2 }))
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: -1 } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 'x', requests: 1 } } }).success, false)
  })
})

describe('applyActivity: event filtering', () => {
  test('non-assistant events return the state unchanged (same reference)', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    for (const type of ['user/message', 'request/header', 'turn/start', 'bogus/event']) {
      assert.ok(applyActivity(state, { type, seq: 1, time: at(0), data: {} } as never) === state, type)
    }
  })

  test('a settlement with an unreadable time is dropped whole', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    assert.ok(applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 1 })) === state, 'NaN time')
    assert.ok(applyActivity(state, assistantMessage(1e30, { inputTokens: 1 })) === state, 'out-of-range time')
    assert.ok(applyActivity(state, assistantMessage(-2 * 86_400_000, { inputTokens: 1 })) === state, 'pre-epoch time')
    assert.deepEqual(state, { days: {} })
  })

  test('a tagged fork/seed marker resets the ledger; the untagged resume marker keeps it', () => {
    // A seeded fork's inherited prefix: one settlement the parent session
    // already booked, plus the step slot its open tail left armed (issue #94).
    let state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 10 }))
    state = applyActivity(state, { type: 'step/start', seq: 2, time: at(0), data: {} } as never)
    const seeded = state
    assert.ok(seeded.stepStart !== undefined)

    for (const data of [undefined, null, {}, { inherited: 'yes' }]) {
      assert.ok(
        applyActivity(seeded, { type: 'session/end-seed', seq: 3, time: at(0), data } as never) === seeded,
        `data ${JSON.stringify(data)} must not reset`,
      )
    }
    assert.deepEqual(seeded.days, { '2026-01-01': { tokens: 10, requests: 1 } })

    const cut = applyActivity(seeded, { type: 'session/end-seed', seq: 3, time: at(0), data: { inherited: true } } as never)
    assert.deepEqual(cut, { days: {} }, 'the inherited ledger and the armed step slot die at the cut')

    const after = applyActivity(cut, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(after.days, { '2026-01-02': { tokens: 3, requests: 1 } })
  })
})

describe('applyActivity: the ledger', () => {
  test('a metered settlement books the disjoint buckets summed into its day', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 5,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 21, requests: 1 } })
  })

  test('same-day settlements accumulate; distinct days key apart', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, assistantMessage(at(0), { outputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 16, requests: 2 },
      '2026-01-02': { tokens: 3, requests: 1 },
    })
  })

  test('a settlement without usage counts its request without fabricating tokens', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0)))
    state = applyActivity(state, assistantMessage(at(0), null))
    state = applyActivity(state, assistantMessage(at(0), 'usage'))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 3 } })
  })

  test('usage buckets are sanitized: fractions round, negatives clamp, garbage reads absent', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10.4,
      cacheReadTokens: -7,
      cacheWriteTokens: '6',
      outputTokens: Number.NaN,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 16, requests: 1 } })
  })

  test('a fully unreadable usage object books zero tokens but keeps the request', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 'x', outputTokens: null }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 1 } })
  })

  test('the persisted previous state is never mutated (copy-on-write)', () => {
    const before = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const after = applyActivity(before, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(before.days, { '2026-01-01': { tokens: 1, requests: 1 } })
    assert.ok(before !== after)
    assert.ok(before.days !== after.days)
  })

  test('the retention cap evicts the oldest day keys (chronological = lexicographic)', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false, 'the oldest day dropped')
    assert.equal(keys.includes('2026-01-02'), true, 'the kept suffix starts the next day')
    // Later folds within the cap keep every day.
    state = applyActivity(state, assistantMessage(at(400), { inputTokens: 1 }))
    assert.equal(Object.keys(state.days).length, 400)
    assert.equal(state.days['2027-02-05'].requests, 2)
  })
})

describe('contextActivity unit: the view', () => {
  test('the view copies the ledger (the wire never shares the fold’s record)', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 1 }))
    const view = def.wire.view(state)
    assert.ok(view.days !== state.days)
    view.days['2026-01-01'].tokens = 999
    assert.equal(state.days['2026-01-01'].tokens, 1)
  })
})

/** A `user/message` carrying (or faking) a `skill-invocation` source. */
function skillInvocation(time: number, source: unknown): SessionEvent {
  return { type: 'user/message', seq: 1, time, data: { source } } as never
}

function toolCall(time: number, callId: unknown, name: unknown): SessionEvent {
  return { type: 'tool/call', seq: 1, time, data: { callId, name } } as never
}

function skillResult(time: number, text: string, callId?: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time,
    data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
  } as never
}

const INVOCATION = { kind: 'skill-invocation', name: 'tdd', form: 'instructions' }

describe('applyActivity: skill loads', () => {
  test('a `/name` invocation books its name on its day', () => {
    const state = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1, last: at(0) } } },
    })
  })

  test('a `skill`-tool result books the wrapper’s name only when paired to a `skill` call', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    assert.deepEqual(state.skillCalls, ['c1'], 'the call arms the pairing claim')
    state = applyActivity(state, skillResult(at(0), '<skill_content name="ponytail">…</skill_content>', 'c1'))
    assert.deepEqual(state.days['2026-01-01'].skills, { ponytail: { n: 1, last: at(0) } })
    assert.equal(state.skillCalls, undefined, 'the claim consumes once')
  })

  test('a wrapper in another tool’s result books nothing (a `read` quoting the wrapper is no load)', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'read'))
    state = applyActivity(state, skillResult(at(0), 'source text quoting <skill_content name="…"> inline', 'c1'))
    assert.deepEqual(state.days, {})
    // Wholly unpaired results book nothing either (a trimmed/foreign call).
    state = applyActivity(state, skillResult(at(0), '<skill_content name="ponytail">…</skill_content>', 'c9'))
    assert.deepEqual(state.days, {})
  })

  test('the lifted toolCallId and the durable source callId both pair', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    const viaSource = {
      type: 'tool/result',
      seq: 2,
      time: at(0),
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '<skill_content name="tdd">…</skill_content>' }] } },
    } as never
    state = applyActivity(state, viaSource)
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
  })

  test('a paired result without the wrapper consumes the claim but books nothing', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    state = applyActivity(state, skillResult(at(0), 'skill load failed', 'c1'))
    assert.deepEqual(state.days, {})
    assert.equal(state.skillCalls, undefined)
  })

  test('consuming one claim keeps the others pending', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    state = applyActivity(state, toolCall(at(0), 'c2', 'skill'))
    state = applyActivity(state, skillResult(at(0), '<skill_content name="tdd">…</skill_content>', 'c1'))
    assert.deepEqual(state.skillCalls, ['c2'], 'the drained claim leaves its sibling armed')
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
  })

  test('the pairing list is bounded and duplicate arms are inert', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, toolCall(at(0), 'c1', 'skill'))
    assert.ok(applyActivity(state, toolCall(at(0), 'c1', 'skill')) === state, 're-arming the same id is a no-op')
    for (let i = 0; i < 120; i++) {
      state = applyActivity(state, toolCall(at(0), `x${i}`, 'skill'))
    }
    assert.equal(state.skillCalls?.length, 100, 'the oldest pending claims drop first')
    assert.equal(state.skillCalls?.includes('c1'), false)
    // Non-skill calls and unreadable ids never arm.
    for (const ev of [
      toolCall(at(0), 'c2', 'bash'),
      toolCall(at(0), 7, 'skill'),
      toolCall(at(0), '', 'skill'),
      toolCall(at(0), undefined, 'skill'),
      { type: 'tool/call', seq: 1, time: at(0), data: null } as never,
    ]) {
      assert.ok(applyActivity(state, ev) === state, JSON.stringify(ev.data))
    }
  })

  test('loads tally per name; the last instant never walks back on a disordered replay', () => {
    let state = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    state = applyActivity(state, toolCall(at(0) + 60_000, 'c1', 'skill'))
    state = applyActivity(state, skillResult(at(0) + 60_000, '<skill_content name="tdd">…</skill_content>', 'c1'))
    state = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'tdd' }))
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 3, last: at(0) + 60_000 } })
    state = applyActivity(state, skillInvocation(at(1), INVOCATION))
    assert.deepEqual(state.days['2026-01-02'].skills, { tdd: { n: 1, last: at(1) } }, 'distinct days key apart')
  })

  test('a developer/message carrier books its source too', () => {
    const event = {
      type: 'developer/message',
      seq: 1,
      time: at(0),
      data: { message: { source: INVOCATION } },
    } as never
    const state = applyActivity({ days: {} }, event)
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
  })

  test('non-load messages and hostile payloads return the state unchanged', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const cases: SessionEvent[] = [
      skillInvocation(at(0), undefined), // no source
      skillInvocation(at(0), null),
      skillInvocation(at(0), 'skill-invocation'), // non-object source
      skillInvocation(at(0), { kind: 'plugin', name: 'tdd' }), // another kind
      skillInvocation(at(0), { kind: 'skill-invocation' }), // name absent
      skillInvocation(at(0), { kind: 'skill-invocation', name: 7 }), // non-string name
      skillInvocation(at(0), { kind: 'skill-invocation', name: '' }), // empty name
      { type: 'user/message', seq: 1, time: at(0), data: null } as never, // no data
      { type: 'user/message', seq: 1, time: Number.NaN, data: { source: INVOCATION } } as never, // unreadable time
      skillResult(at(0), '<skill_content name="tdd">…</skill_content>'), // no call id at all
      { type: 'tool/result', seq: 1, time: at(0), data: null } as never, // no data
      { type: 'tool/result', seq: 1, time: at(0), data: { message: null } } as never, // no message
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { toolCallId: 7 } } } as never, // unreadable ids
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { toolCallId: '' } } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { source: { callId: 9 } } } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { source: 'x' } } } as never,
    ]
    for (const event of cases) {
      assert.ok(applyActivity(state, event) === state, JSON.stringify(event.data))
    }
  })

  test('a settlement keeps the day’s skill table; the seed reset clears it', () => {
    let state = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 4 }))
    assert.deepEqual(state.days['2026-01-01'], {
      tokens: 4,
      requests: 1,
      skills: { tdd: { n: 1, last: at(0) } },
    })
    const cut = applyActivity(state, { type: 'session/end-seed', seq: 2, time: at(0), data: { inherited: true } } as never)
    assert.deepEqual(cut, { days: {} })
  })

  test('a skill load on a priced day keeps the day’s tokens and fee', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, skillInvocation(at(0), INVOCATION))
    const day = state.days['2026-01-01']
    assert.equal(day.tokens, 15)
    assert.equal(day.requests, 1)
    assert.ok(day.cost !== undefined, 'the pricing record rides on')
    assert.deepEqual(day.skills, { tdd: { n: 1, last: at(0) } })
  })

  test('the persisted previous state is never mutated (skill path copy-on-write)', () => {
    const before = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    const after = applyActivity(before, skillInvocation(at(0), INVOCATION))
    assert.deepEqual(before.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
    assert.deepEqual(after.days['2026-01-01'].skills, { tdd: { n: 2, last: at(0) } })
  })

  test('a day’s name table is capped: new names drop, booked names keep tallying', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let i = 0; i < 100; i++) {
      state = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: `skill-${i}` }))
    }
    const capped = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'skill-100' }))
    assert.ok(capped === state, 'the 101st distinct name books nothing')
    const again = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'skill-0' }))
    assert.equal(again.days['2026-01-01'].skills?.['skill-0'].n, 2, 'a booked name still grows')
  })

  test('the wire view passes its schema with a skill table; the state schema round-trips it', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), skillInvocation(at(0), INVOCATION))
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1.5, last: 0 } } } } }).success, false, 'a fractional tally')
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1 } } } } }).success, false, 'a missing last')
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1, last: Number.NaN } } } } }).success, false, 'a non-finite last')
    assert.equal(def.stateSchema.safeParse({ days: {}, skillCalls: ['c1'] }).success, true, 'pending skill-call claims round-trip')
    assert.equal(def.stateSchema.safeParse({ days: {}, skillCalls: [7] }).success, false, 'claims are strings')
  })
})

/** A `request/header` event carrying the route in force (the fold's only model/provider source). */
function requestHeader(model: unknown, provider: unknown): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: at(0),
    data: { header: { config: { model, provider } } },
  } as never
}

function stepStart(time: number): SessionEvent {
  return { type: 'step/start', seq: 1, time, data: {} } as never
}

function stepEnd(time: number): SessionEvent {
  return { type: 'step/end', seq: 1, time, data: {} } as never
}

/** Deterministic UTC instants: Thursday 02:00 (a peak window) and Saturday 12:00 (off-peak). */
const PEAK_UTC = Date.UTC(2026, 0, 1, 2)
const OFF_UTC = Date.UTC(2026, 0, 3, 12)

describe('applyActivity: the route in force', () => {
  test('a header books later settlements under its (provider, model); the last header wins', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, requestHeader('glm-5', 'zai-coding-cn'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 3 }))
    const day = state.days[dayKeyOf(PEAK_UTC) ?? '']
    assert.deepEqual(day?.cost, {
      'deepseek-official': { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5 } } },
      'zai-coding-cn': { 'glm-5': { peak: { uncached: 3, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
  })

  test('a header without readable route fields returns the state unchanged (same reference)', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    for (const ev of [
      { type: 'request/header', seq: 1, time: at(0), data: null },
      { type: 'request/header', seq: 1, time: at(0), data: {} },
      { type: 'request/header', seq: 1, time: at(0), data: { header: null } },
      { type: 'request/header', seq: 1, time: at(0), data: { header: { config: 'x' } } },
      { type: 'request/header', seq: 1, time: at(0), data: { header: { config: { model: 7, provider: true } } } },
    ] as never as SessionEvent[]) {
      assert.ok(applyActivity(state, ev) === state)
    }
  })

  test('an identical header returns the same reference', () => {
    const state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    assert.ok(applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official')) === state, 'no change, no copy')
  })

  test('a provider-only header tracks the provider without materializing a model field', () => {
    let state = applyActivity({ days: {} }, requestHeader(undefined, 'deepseek-official'))
    assert.ok(!('model' in state), 'the absent model stays absent (plain-JSON precondition)')
    assert.equal(state.provider, 'deepseek-official')
    // No model in force: the settlement still books no fee.
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 2 }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 2, requests: 1 } })
  })

  test('a settlement with no route in force books its tokens and request but no fee', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 4 }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 4, requests: 1 } }, 'no model, no fabricated fee')
  })

  test('a model without a provider books under the empty provider, at list price', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', undefined))
    state = applyActivity(state, assistantMessage(OFF_UTC, { inputTokens: 10 }))
    const day = state.days[dayKeyOf(OFF_UTC) ?? '']
    assert.deepEqual(day?.cost, { '': { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      'an unattributed provider is not DeepSeek, so no off-peak halving')
  })
})

describe('applyActivity: the initiation stamp', () => {
  test('a settlement books the day its step STARTED, across local midnight', () => {
    const late = new Date(2026, 0, 1, 23, 30).getTime()
    const early = new Date(2026, 0, 2, 0, 30).getTime()
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(late))
    state = applyActivity(state, assistantMessage(early, { inputTokens: 6 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-01'], 'the initiation day, not the settlement day')
    assert.equal(state.days['2026-01-01'].tokens, 6)
  })

  test('step/end clears the stamp; the next settlement books its own day', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepEnd(at(0)))
    assert.ok(!('stepStart' in state), 'the field is deleted, never materialized as undefined')
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-02'])
  })

  test('an unreadable settlement time still books over a valid stamp', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 9 }))
    assert.deepEqual(state.days, {
      '2026-01-01': {
        tokens: 9,
        requests: 1,
        cost: { 'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      },
    })
  })

  test('a non-finite step/start never arms the slot; a stale stamp stays armed like the timeline fold', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, stepStart(Number.NaN))
    assert.ok(applyActivity(state, stepStart(Number.NaN)) === state)
    state = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepEnd(at(1)))
    assert.ok(!('stepStart' in state), 'step/end without an armed slot is a no-op')
  })

  test('a step/end over an unarmed slot returns the state unchanged (same reference)', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0)))
    assert.ok(applyActivity(state, stepEnd(at(0))) === state)
  })
})

describe('applyActivity: the per-day pricing record', () => {
  test('DeepSeek peak windows book the doubled list price; off-peak books the plain one', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 100, cacheReadTokens: 10 }))
    state = applyActivity(state, assistantMessage(OFF_UTC, { inputTokens: 100, cacheReadTokens: 10 }))
    assert.deepEqual(state.days[dayKeyOf(PEAK_UTC) ?? '']?.cost, {
      'deepseek-official': { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 10, cacheWrite: 0, output: 0 } } },
    })
    assert.deepEqual(state.days[dayKeyOf(OFF_UTC) ?? '']?.cost, {
      'deepseek-official': { 'deepseek-v4': { off: { uncached: 100, cacheRead: 10, cacheWrite: 0, output: 0 } } },
    })
  })

  test('same-day settlements accumulate into the day’s record', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 3 }))
    assert.deepEqual(state.days['2026-01-01'].cost, {
      'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 4, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
  })

  test('an unmetered settlement keeps the day’s existing record; the ledger never loses it', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(0)))
    assert.deepEqual(state.days['2026-01-01'], {
      tokens: 1,
      requests: 2,
      cost: { 'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
  })

  test('the retention cap evicts priced days with their day', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false)
    assert.ok(state.days['2027-02-05'].cost !== undefined, 'the kept suffix keeps its fee')
  })
})

describe('contextActivity unit: the schemas over the pricing record', () => {
  test('the state schema accepts the route and stamp fields; the wire passes its schema', () => {
    const def = createContextActivityDefinition()
    let state = applyActivity(def.init(), requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: {}, model: 'm', provider: 'p', stepStart: 1 }).success, true)
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.deepEqual(view.days, state.days, 'the view copies the entries whole')
  })

  test('the served view never aliases a day\'s nested cost or skill records', () => {
    const def = createContextActivityDefinition()
    let state = applyActivity(def.init(), requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    state = applyActivity(state, skillInvocation(at(0), INVOCATION))
    const view = def.wire.view(state)
    const day = Object.keys(state.days)[0]
    const served = view.days[day]
    const persisted = state.days[day]
    assert.ok(persisted.cost !== undefined && persisted.skills !== undefined, 'the fixture carries both records')
    // `cost` is four levels deep and `skills` two; a shallow day copy would leave both pointing at persisted state,
    // so a mutating registry, cache writer, or wire payload would write straight into the fold's own record.
    assert.notEqual(served.cost, persisted.cost)
    assert.notEqual(served.cost?.['deepseek-official'], persisted.cost?.['deepseek-official'])
    assert.notEqual(served.cost?.['deepseek-official']?.['deepseek-v4'], persisted.cost?.['deepseek-official']?.['deepseek-v4'])
    // The fixture's instant is local noon, so the booked period follows the machine's timezone.
    const period = isPeakUtc(at(0)) ? 'peak' : 'off'
    assert.notEqual(served.cost?.['deepseek-official']?.['deepseek-v4']?.[period], persisted.cost?.['deepseek-official']?.['deepseek-v4']?.[period])
    assert.notEqual(served.skills, persisted.skills)
    assert.notEqual(served.skills?.tdd, persisted.skills?.tdd)
    assert.deepEqual(served, persisted)
  })

  test('a malformed pricing record fails both schemas (strict: no drift)', () => {
    const def = createContextActivityDefinition()
    const bad = {
      days: { '2026-01-01': { tokens: 1, requests: 1, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 'x' } } } } } },
    }
    assert.equal(def.stateSchema.safeParse(bad).success, false)
    assert.equal(def.wire.viewSchema.safeParse(bad).success, false)
    assert.equal(contextActivitySchema.safeParse(bad).success, false)
  })
})
