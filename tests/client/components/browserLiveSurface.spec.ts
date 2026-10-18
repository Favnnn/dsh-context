import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeContextBrowser, stepStampOf } from '../../../src/client/components/browser'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import type { ContextHeaders, RequestRecord } from '../../../src/shared/types'
import { createContextSettings } from '../../../src/client/settings'
import { click, flush, hover, mount, query, queryAll, surfaceNode, text, unhover, type Mounted } from '../helpers/kit'
import { Browser, ROW, catRow, elemRows, kit, pickStep, props, req, tl, withEpochContent } from './browserHarness'

async function clickDeltaBase(m: Mounted, label: 'prev step' | 'prev turn'): Promise<void> {
  const btn = queryAll(m.container, '.lc-card-title .lc-gran-btn').find(b => text(b) === label)
  assert.ok(btn !== undefined, `toggle button ${label} exists`)
  await click(btn)
}

describe('ContextBrowser live surface', () => {
  test('the settings card default wins as the baseline toggle mount state', async () => {
    const prefs = createContextSettings()
    prefs.set('defaultDeltaBase', 'turn')
    const PrefBrowser = makeContextBrowser(kit, makeStackedBar(kit), prefs)
    const m = await mount(h(PrefBrowser, props({ data: tl({}) })))
    const baseBtns = queryAll(m.container, '.lc-card-title .lc-gran-btn')
    const turnBtn = baseBtns.find(b => text(b) === 'prev turn')
    assert.ok(turnBtn !== undefined && turnBtn.className.includes('lc-gran-on'), 'the persisted baseline is active at mount')
    const stepBtn = baseBtns.find(b => text(b) === 'prev step')
    assert.ok(stepBtn !== undefined && !stepBtn.className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('title, picker, live meta, category rows; empty categories stay shut', async () => {
    const data = tl({
      current: { system: 100, tools: 200, user: 50, inject: 0, skill: 0, assistant: 0, tool: 0, total: 350 },
      requests: [
        req({ seq: 10, turn: 1, step: 0 }),
        req({ seq: 20, turn: 1, step: 1, prompt: 800 }),
        req({ seq: 7, time: 500, turn: undefined, step: undefined }),
      ],
      nodes: [surfaceNode({ seq: 1, text: 'hello' })],
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(query(m.container, '.lc-card-title-text')).includes('Context Browser'))
    const baseBtns = queryAll(m.container, '.lc-card-title .lc-gran-btn')
    const stepBtn = baseBtns.find(b => text(b) === 'prev step')
    assert.ok(stepBtn !== undefined && stepBtn.className.includes('lc-gran-on'), 'step baseline is the default')
    assert.ok(baseBtns.some(b => text(b) === 'prev turn' && !b.className.includes('lc-gran-on')))
    const sel = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(sel.value, 'live')
    const options = queryAll(sel, 'option').map(o => text(o))
    assert.equal(options.length, 4, 'live + one option per request')
    assert.equal(options[0], 'Live (Next Request)')
    assert.equal(options[3], 'Turn 1 · Step 0 of 2', 'options carry the step label without a time suffix')
    assert.ok(options.some(o => o.includes('Turn 0 · Step 0')), 'requests without turn/step degrade to zeroes')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Live · Next Request'))
    assert.ok(meta.includes('Estimated ≈ 350'))
    assert.ok(meta.includes('Actual 800'), 'live pairs the estimate with the freshest actual')
    // Live in 'prev turn' mode: the freshest request is turn-less (degrades to turn 0), so no previous
    // turn exists — the zero baseline shows the whole live makeup as change.
    await clickDeltaBase(m, 'prev turn')
    const liveUserCat = queryAll(m.container, '.lc-br-cat')[ROW.user]
    assert.equal(text(query(liveUserCat, '.lc-br-delta')), '+1')
    assert.equal(text(query(liveUserCat, '.lc-br-tdelta')), '+50')
    await clickDeltaBase(m, 'prev step')
    assert.equal(queryAll(m.container, '.lc-br-cat-row').length, 7)
    assert.ok(text(catRow(m, 'user')).includes('1 Items'))
    assert.ok(queryAll(m.container, '.lc-br-cat')[ROW.inject].className.includes('lc-br-cat-empty'), 'empty category is marked')
    await pickStep(m, '7')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 0 · Step 0'))
    assert.ok(!meta2.includes('Actual'), 'this freshest request reported no usage')
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0, 'the seq-7 view and its seq-20 baseline hold the same single node')
    // Turn mode on a turn-less record: 'turn − 1' degrades to −1, no baseline turn exists —
    // the zero baseline shows the step's single node as pure change.
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(m.container, '.lc-br-delta')), '+1')
    await pickStep(m, 'live')
    await click(catRow(m, 'inject'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    assert.ok(queryAll(m.container, '.lc-br-pct').some(el => text(el).endsWith('%')))
    await m.unmount()
  })

  test('zero-total surface renders no percentages; no requests means no delta pills', async () => {
    const m = await mount(h(Browser, props({ data: tl({}) })))
    assert.ok(queryAll(m.container, '.lc-br-pct').every(el => text(el) === ''))
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 0)
    await clickDeltaBase(m, 'prev turn')
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 0)
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Estimated ≈ 0'))
    assert.ok(!meta.includes('Actual'), 'no requests, no actual figure')
    await m.unmount()
  })

  test('dropped live nodes raise the missing-window note, live and on later steps only', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 3, turn: 1, step: 0 }), req({ seq: 10, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 6, text: 'served' })],
      droppedNodes: 2,
      surfaceFloor: 5,
      archiveFloor: 8,
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'), 'live flags the dropped tail')
    // Step before the floor: the dropped slice is not attributable → no note.
    await pickStep(m, '3')
    assert.ok(!text(m.container).includes('earlier messages are also part'))
    assert.ok(text(m.container).includes('approximate'), 'seq below the archive floor is approximate')
    // Step after the floor: the dropped slice is inside the context.
    await pickStep(m, '10')
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'))
    assert.ok(!text(m.container).includes('approximate'), 'seq at/after the archive floor is exact')
    await m.unmount()
  })

  test('step picking switches the assembled view; back-to-live restores the surface', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 30, inject: 0, skill: 0, assistant: 10, tool: 0, total: 40 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 25 }), req({ seq: 20, turn: 1, step: 1, user: 30, assistant: 10, prompt: 800 })],
      nodes: [surfaceNode({ seq: 1, text: 'first question' }), surfaceNode({ seq: 11, cat: 'assistant', tokens: 10, text: 'first answer' })],
      archive: [surfaceNode({ seq: 0, tokens: 5, text: 'archived hello', gone: 15 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '10')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(!meta.includes('Actual'), 'this step reported no usage')
    // The step's surface: archived node (gone 15 > 10) + seq 1; seq 11 is the response.
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 2, 'archived + live nodes reconstructed')
    assert.ok(text(m.container).includes('archived hello'))
    await pickStep(m, '20')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 1 · Step 1'))
    assert.ok(meta2.includes('Actual 800'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'picking a step collapses the accordion')
    await pickStep(m, 'live')
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1, 'live excludes removed nodes')
    assert.ok(!text(m.container).includes('archived hello'))
    await m.unmount()
  })

  test('delta pills follow the picked baseline; a predecessor-less step diffs against zero', async () => {
    const data = tl({
      current: { system: 1, tools: 2, user: 99, inject: 0, skill: 0, assistant: 0, tool: 0, total: 102 },
      requests: [
        req({ seq: 1, turn: 1, step: 0, system: 1, tools: 2, user: 10, total: 13 }),
        req({ seq: 2, turn: 1, step: 1, system: 1, tools: 2, user: 20, total: 23 }),
        req({ seq: 3, turn: 2, step: 0, system: 1, tools: 2, user: 30, total: 33 }),
        req({ seq: 4, turn: 2, step: 1, system: 1, tools: 2, user: 40, total: 43 }),
        req({ seq: 5, turn: 3, step: 0, system: 1, tools: 2, user: 50, total: 53 }),
      ],
      nodes: [0, 1, 2, 3, 4, 5].map(seq => surfaceNode({ seq, tokens: seq })),
    })
    const m = await mount(h(Browser, props({ data })))
    const userRow = (): HTMLElement => queryAll(m.container, '.lc-br-cat')[ROW.user]
    // Default 'prev step': step 4 reads against step 3, its immediate predecessor.
    await pickStep(m, '4')
    const countPills = queryAll(userRow(), '.lc-br-delta')
    assert.equal(countPills.length, 1, 'only the user count changed')
    assert.equal(text(countPills[0]), '+1')
    assert.ok(countPills[0].className.includes('lc-br-delta-up'))
    const tokenPills = queryAll(userRow(), '.lc-br-tdelta')
    assert.equal(tokenPills.length, 1)
    assert.equal(text(tokenPills[0]), '+10')
    // The log's first step has no predecessor: the zero baseline shows the full makeup as change,
    // EVERY category included (system +1, tools +2, user +10).
    await pickStep(m, '1')
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 3)
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    // 'prev turn': step 4 reads against turn 1's last step (seq 2).
    await pickStep(m, '4')
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+2')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+20')
    // A first-turn step in 'prev turn' mode has no baseline either: zero again.
    await pickStep(m, '1')
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 3)
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    // Live: 'prev step' reads the last request; 'prev turn' reads the previous turn's last step (seq 4).
    await pickStep(m, 'live')
    await clickDeltaBase(m, 'prev step')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+49')
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+2')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+59')
    await clickDeltaBase(m, 'prev step')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+49')
    await m.unmount()
  })

  test('shrinking categories render downward pills', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 15, inject: 0, skill: 0, assistant: 0, tool: 0, total: 15 },
      requests: [
        req({ seq: 2, turn: 1, step: 1, user: 25, total: 25 }),
        req({ seq: 3, turn: 2, step: 0, user: 15, total: 15 }),
      ],
      nodes: [surfaceNode({ seq: 1, tokens: 10, text: 'kept' })],
      archive: [surfaceNode({ seq: 0, tokens: 15, text: 'pruned away', gone: 3 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '3')
    const countPill = query(m.container, '.lc-br-delta')
    assert.equal(text(countPill), '-1', 'the archived node left the step’s surface')
    assert.ok(countPill.className.includes('lc-br-delta-down'))
    const tokenPill = query(m.container, '.lc-br-tdelta')
    assert.equal(text(tokenPill), '-10')
    assert.ok(tokenPill.className.includes('lc-br-tdelta-down'))
    await m.unmount()
  })

  test('hover linkage: category rows report hovers and mirror the shared key while live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10 })],
      nodes: [surfaceNode({ seq: 1, text: 'hi' })],
    })
    const hovers: (string | null)[] = []
    const el = h(Browser, props({ data, hoverKey: null, onHoverKey: (k) => { hovers.push(k) } }))
    const m = await mount(el)
    await hover(catRow(m, 'user'))
    await unhover(catRow(m, 'user'))
    assert.deepEqual(hovers, ['user', null])
    // Mirrored hover lights the row; the 'free' key has no category row.
    await m.update(h(Browser, props({ data, hoverKey: 'user', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.update(h(Browser, props({ data, hoverKey: 'free', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    // A picked step has a different composition: the linkage drops.
    await pickStep(m, '10')
    const before = hovers.length
    await hover(catRow(m, 'user'))
    assert.equal(hovers.length, before, 'no hover reporting while a step is shown')
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.unmount()

    const m2 = await mount(h(Browser, props({ data })))
    await hover(catRow(m2, 'user'))
    await m2.unmount()
  })

  test('previewSeq transiently shows a step; unknown preview/pin seqs fall back to live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10, prompt: 700 })],
      nodes: [surfaceNode({ seq: 1, text: 'hi' })],
    })
    const m = await mount(h(Browser, props({ data, previewSeq: 10 })))
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(meta.includes('Actual 700'))
    // Unknown preview seq: no request matches → live surface, estimate paired with the freshest actual.
    await m.update(h(Browser, props({ data, previewSeq: 999 })))
    const liveMeta = text(query(m.container, '.lc-br-meta'))
    assert.ok(liveMeta.includes('Live · Next Request'))
    assert.ok(liveMeta.includes('Actual 700'))
    // A pinned step trimmed out of retention falls back to live too.
    await m.update(h(Browser, props({ data, previewSeq: null, pinSeq: 999 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    await m.unmount()
  })

  test('element rows carry the introducing step stamp merged with the time (T{t} S{s} · clock); the live tail carries none', async () => {
    const data = tl({
      current: { system: 10, tools: 10, user: 10, inject: 10, skill: 10, assistant: 10, tool: 10, total: 70 },
      requests: [
        req({ seq: 20, turn: 1, step: 1 }),
        req({ seq: 30, turn: 1, step: 2 }),
        req({ seq: 40, turn: 2, step: 1 }),
      ],
      systems: [{ seq: 22, time: 100, tokens: 10 }],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'inject', tokens: 1, form: 'snapshot', text: 'state', time: 60_000 }),
        surfaceNode({ seq: 35, cat: 'assistant', tokens: 1 }),
        surfaceNode({ seq: 36, cat: 'skill', tokens: 1, skill: 's' }),
        surfaceNode({ seq: 45, cat: 'tool', tokens: 1, tool: 'bash' }),
      ],
    })
    // The header epoch at seq 22 enters the context with the seq-30 request, like the inject node.
    const headers: ContextHeaders = { headers: [{ seq: 22, time: 100, systemTokens: 10, tools: [{ name: 't1', tokens: 5 }] }] }
    const epoch = withEpochContent(headers, { 22: { system: 'SYS', tools: [{ name: 't1', schema: {} }] } })
    const m = await mount(h(Browser, props({ data, headers: epoch.headers, fetchHeader: epoch.fetchHeader })))
    const stampOfCat = async (cat: keyof typeof ROW): Promise<string[]> => {
      await click(catRow(m, cat))
      await flush()
      const body = query(queryAll(m.container, '.lc-br-cat')[ROW[cat]], '.lc-br-body')
      return queryAll(body, '.lc-br-time').map(el => text(el))
    }
    assert.deepEqual(await stampOfCat('user'), ['T1 S1'], 'a stamp without a clock stands alone')
    const [injectStamp] = await stampOfCat('inject')
    assert.match(injectStamp, /^T1 S2 · \d{2}:\d{2}:\d{2}$/, 'the stamp merges with the clock into one run')
    assert.deepEqual(await stampOfCat('assistant'), ['T2 S1'])
    assert.deepEqual(await stampOfCat('skill'), ['T2 S1'])
    // The tool result landed after the last logged request: no request carries it yet, so it wears the
    // PENDING estimate — the newest tail item is a tool result, the turn continues, next step predicted.
    await click(catRow(m, 'tool'))
    await flush()
    const toolBody = query(queryAll(m.container, '.lc-br-cat')[ROW.tool], '.lc-br-body')
    const pendingMeta = query(toolBody, '.lc-br-time')
    assert.equal(text(pendingMeta), 'T2 S2')
    assert.ok(pendingMeta.className.includes('lc-br-time-pending'), 'the pending estimate wears the dotted underline')
    assert.equal(pendingMeta.title, 'Expected in the Turn 2 · Step 2 request (not yet sent)')
    assert.equal(queryAll(toolBody, '.lc-br-elem-row').length, 1, 'the row still renders with the pending stamp')
    // System prompt and tool schemas share the epoch's introducing step.
    assert.deepEqual(await stampOfCat('system'), ['T1 S2'])
    assert.deepEqual(await stampOfCat('tools'), ['T1 S2'])
    const tip = query(queryAll(m.container, '.lc-br-cat')[ROW.tools], '.lc-br-time').title
    assert.equal(tip, 'First carried by the Turn 1 · Step 2 request')
    await m.unmount()
  })

  test('pending tail stamp: a newest user message predicts the next turn\'s first step', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 10, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'tool', tokens: 1, tool: 'bash' }),
        surfaceNode({ seq: 30, cat: 'user', tokens: 1 }),
      ],
    })
    const m = await mount(h(Browser, props({ data })))
    await click(catRow(m, 'tool'))
    await flush()
    const toolBody = query(queryAll(m.container, '.lc-br-cat')[ROW.tool], '.lc-br-body')
    assert.equal(text(query(toolBody, '.lc-br-time')), 'T2 S1', 'a waiting user message opens the next turn')
    await m.unmount()
  })

  test('pending tail stamp: a text-only final reply ended the turn; a reply with pending calls continues it', async () => {
    const ended = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'assistant', tokens: 1, text: 'final answer' }),
      ],
    })
    const m1 = await mount(h(Browser, props({ data: ended })))
    await click(catRow(m1, 'assistant'))
    await flush()
    assert.equal(text(query(query(queryAll(m1.container, '.lc-br-cat')[ROW.assistant], '.lc-br-body'), '.lc-br-time')), 'T2 S1')
    await m1.unmount()
    const continuing = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'assistant', tokens: 1, calls: ['bash'] }),
      ],
    })
    const m2 = await mount(h(Browser, props({ data: continuing })))
    await click(catRow(m2, 'assistant'))
    await flush()
    assert.equal(text(query(query(queryAll(m2.container, '.lc-br-cat')[ROW.assistant], '.lc-br-body'), '.lc-br-time')), 'T1 S2')
    await m2.unmount()
  })
})

describe('stepStampOf', () => {
  const r = (seq: number, turn?: number, step?: number): RequestRecord => req({ seq, turn, step })

  test('an item stamps to the FIRST request logged after it, whatever the wire order', () => {
    const input = [r(30, 2, 1), r(10, 1, 1), r(20, 1, 2)]
    const stamp = stepStampOf(input)
    assert.deepEqual(stamp(5), { turn: 1, step: 1 })
    assert.deepEqual(stamp(10), { turn: 1, step: 2 }, 'an item AT a request seq is carried by the NEXT request')
    assert.deepEqual(stamp(25), { turn: 2, step: 1 })
    assert.equal(input[0].seq, 30, 'the caller array is not reordered')
  })

  test('the live tail and turn-less introducers stamp null', () => {
    const stamp = stepStampOf([r(10, undefined, undefined), r(20, 1, 1)])
    assert.equal(stamp(5), null, 'the introducing request carries no turn/step numbers')
    assert.deepEqual(stamp(15), { turn: 1, step: 1 })
    assert.equal(stamp(25), null, 'no request follows the item yet')
  })
})

