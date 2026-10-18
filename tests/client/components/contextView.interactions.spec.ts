import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { UseChatLike } from '../../../src/client/services'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'
import { buttonByText, makeView, mountRich, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — interactions', () => {
  test('renders the rich tab: stats, chart bars, markers, events, nodes, browser', async () => {
    const m = await mountRich('sv-rich')
    assert.ok(text(m.container).includes('deepseek-v4-flash · deepseek'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    // The compaction event lands as the ✂ marker on the first request after it.
    assert.equal(queryAll(m.container, '.lc-bar-marker').length, 1)
    assert.equal(queryAll(m.container, '.lc-event').length, 2)
    assert.ok(text(m.container).includes(DICT_EN['files.title']))
    assert.ok(text(m.container).includes(DICT_EN['files.scopeLatest']))
    assert.ok(text(m.container).includes(DICT_EN['browser.liveNow']))
    // Turn strip partitions the two turn groups (turn 1 + the turn-less 0).
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(el => text(el)), ['1', '0'])
    await m.unmount()
  })

  test('the browser column caps at the left cards\' full extent, flush with the column, live', async () => {
    // jsdom has no layout: stand in rects for the two left cards only, laid out card + 7px gap, then grow
    // them so the re-measure arm runs.
    const orig = Element.prototype.getBoundingClientRect
    let cardH = 100
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const box = orig.call(this)
      const parent = this.parentElement
      if (!this.classList.contains('lc-card') || parent === null
        || !parent.classList.contains('lc-col') || parent.classList.contains('lc-col-browser')) return box
      const top = 100 + [...parent.children].indexOf(this) * (cardH + 7)
      return { ...box, top, bottom: top + cardH }
    } as never
    try {
      // One View instance across the update, so the second render re-measures in place.
      const View = makeView(new TestClientCtx())
      const el = () => h(View, {
        sessionId: 'sv-cap',
        useProjection: projectionsFor(richTimeline(), {
          contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
        }),
        useChat: (sel => sel({ legacy: { nodes: [] } })) as UseChatLike,
      })
      const m = await mount(el())
      const col = query<HTMLElement>(m.container, '.lc-col-browser')
      assert.equal(col.style.maxHeight, '207px', 'two 100px cards and their 7px gap')
      // The cap only ceilings the card — the card's rows region scrolls; the column never does.
      assert.equal(col.style.overflowY, '')
      assert.ok(query(m.container, '.lc-br-scroll') !== null)
      cardH = 150
      await m.update(el())
      assert.equal(col.style.maxHeight, '307px', 'the cap follows the grown cards on the next render')
      await m.unmount()
    } finally {
      Element.prototype.getBoundingClientRect = orig
    }
  })

  test('bar hover previews in the browser; hover loss on a granularity switch falls back', async () => {
    const m = await mountRich('sv-hover')
    const chart = query(m.container, '.lc-chart')
    const bar2 = query(m.container, '.lc-bar[data-seq="2"]')
    await hover(bar2)
    assert.ok(bar2.className.includes('lc-bar-hovered'))
    // The hovered bar's turn lights the strip even without strip hover.
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    // Switching to turn granularity drops seq 2 (turn 1 keeps its LAST step):
    // the stale hovered seq matches nothing and the active bar falls back.
    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.equal(queryAll(m.container, '.lc-bar-hovered').length, 0)
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    await m.unmount()
  })

  test('a request without a turn highlights nothing on hover', async () => {
    const m = await mountRich('sv-noturn')
    const chart = query(m.container, '.lc-chart')
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-hovered'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(chart)
    await m.unmount()
  })

  test('turn strip hover dims, strip click focuses the turn in turn granularity', async () => {
    const m = await mountRich('sv-strip')
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    await hover(turns[0])
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(query(m.container, '.lc-turns'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    // Strip click: granularity switches to turn and the focus is consumed once.
    await click(turns[0])
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    await m.unmount()
  })

  test('pinning a bar selects its step in the browser; unpinning returns to live', async () => {
    const m = await mountRich('sv-pin')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, 'live')

    const bar4 = query(m.container, '.lc-bar[data-seq="4"]')
    await click(bar4)
    assert.ok(bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, '4')
    assert.ok(query(m.container, '.lc-detail').textContent?.includes('✂') === true)

    await click(bar4)
    assert.ok(!bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const m = await mountRich('sv-brief')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    // Pin the second bar: brief = opener + inputs (node 3) + response (node 4).
    await click(query(m.container, '.lc-bar[data-seq="4"]'))
    const briefRows = queryAll(m.container, '.lc-brief-row')
    assert.equal(briefRows.length, 3)

    // The In row reveals node 3 (tool) inside the step's OWN surface.
    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))

    // The response of a middle bar first appears in the NEXT step's surface.
    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply two'))

    // The last bar's response lands on the LIVE surface.
    await click(query(m.container, '.lc-bar[data-seq="6"]'))
    const lastReply = queryAll(m.container, '.lc-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply three'))
    await m.unmount()
  })

  test('composition legend hover lights the linked browser category', async () => {
    const m = await mountRich('sv-link')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)

    const chip = query(comp, '.lc-legend .lc-chip')
    await hover(chip)
    assert.ok(query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await unhover(chip)
    assert.ok(!query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await m.unmount()
  })

  test('browser category hover lights the trend chart segments and the detail composition bar', async () => {
    const m = await mountRich('sv-link-trend')
    // Category rows render in CATS order; hover "tools" (second row).
    const toolsRow = queryAll(m.container, '.lc-br-cat-row')[1]
    await hover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    // The detail's composition bar mirrors the same key with its tip off (covered in requestDetail.spec).
    const detailBar = query(m.container, '.lc-detail .lc-stacked')
    assert.ok(detailBar.className.includes('lc-stacked-dim'))
    assert.ok(queryAll(detailBar, '.lc-stacked-seg-on').length === 1)
    assert.ok(queryAll(m.container, '.lc-detail .lc-chip-on').length === 1, 'the matching detail chip lights too')

    await unhover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))

    // The overview's 'free' track hover names no category — the trend card stays neutral (same filter as the browser link).
    await hover(query(m.container, '.lc-stacked-free'))
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))
    await unhover(query(m.container, '.lc-stacked-free'))
    await m.unmount()
  })

  test('trend panel chip hover feeds the shared category state back to the composition legend', async () => {
    const m = await mountRich('sv-link-chip')
    // The panel's chips are hover SOURCES, exactly as the composition legend's are; "tools" is the second chip.
    const chip = queryAll(m.container, '.lc-detail .lc-legend .lc-chip')[1]
    await hover(chip)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)
    assert.equal(queryAll(comp, '.lc-legend .lc-chip-on').length, 1, 'the composition legend chip lights with it')
    await unhover(chip)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    await m.unmount()
  })

  test('expanding a browser category focuses the trend bars on it; collapsing restores all', async () => {
    const m = await mountRich('sv-focus')
    assert.equal(text(query(m.container, '.lc-axis-top')), '420', 'unfocused: the axis tops at the largest whole-bar total')
    // Five segments on the bar: richTimeline carries no injects, so inject renders none.
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)

    // Expanding the browser's assistant category (row 5 — row 4 is the empty
    // skill bucket) focuses every bar on it — one segment per bar, the axis
    // rescaled to the category's own max (20/60/80; the first rides its provider-prompt anchor to 21).
    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '80')
    const segs = queryAll(m.container, '.lc-bar .lc-bar-stack > .lc-cat-seg')
    assert.equal(segs.length, 3)
    for (const s of segs) assert.equal(s.getAttribute('data-cat'), 'assistant')

    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)
    await m.unmount()
  })

  test('the adaptive switch rides the trend title and toggles mount-locally', async () => {
    const m = await mountRich('sv-adaptive')
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['trend.title']))
    assert.ok(card !== undefined)
    const titleText = query(card, '.lc-card-title-text')
    assert.equal(text(titleText), DICT_EN['trend.title'])

    // The three display modifiers ride the title text's right as ONE segmented group, left of the
    // card's right-hand control cluster.
    const toggleOf = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    const modsGroupOf = () => buttonByText(m.container, DICT_EN['trend.dna']).parentElement as HTMLElement
    assert.ok(modsGroupOf().className.includes('lc-trend-mods'))
    assert.equal(modsGroupOf().previousElementSibling, titleText)
    assert.equal(toggleOf().parentElement, modsGroupOf())
    assert.equal(toggleOf().previousElementSibling, buttonByText(m.container, DICT_EN['trend.dna']), 'Adaptive rides right of DNA inside the group')
    assert.equal(toggleOf().getAttribute('title'), DICT_EN['trend.adaptiveHint'])
    assert.ok(!toggleOf().className.includes('lc-gran-on'), 'off at mount')

    // Toggling is mount-local: the chart keeps rendering (jsdom has no layout, so the zero-width viewport falls
    // back to the whole-log axis instead of flattening the bars) and nothing is written back to settings.
    await click(toggleOf())
    assert.ok(toggleOf().className.includes('lc-gran-on'))
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')
    await click(toggleOf())
    assert.ok(!toggleOf().className.includes('lc-gran-on'))
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')
    await m.unmount()
  })

  test('the duration toggle overlays the active-time curve with a right-hand quartile axis', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-ms-curve',
      useProjection: projectionsFor(timeline({
        requests: [
          { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, activeMs: 1000 },
          { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400, activeMs: 2000 },
        ],
      })),
    }))

    const msBtn = () => buttonByText(m.container, DICT_EN['trend.duration'])
    const group = msBtn().parentElement as HTMLElement
    assert.ok(group.className.includes('lc-trend-mods'))
    assert.equal(msBtn().getAttribute('title'), DICT_EN['trend.durationTip'])
    assert.equal(msBtn().previousElementSibling, buttonByText(m.container, DICT_EN['trend.adaptive']), 'Duration rides right of the adaptive switch')
    // The settings default (show) mounts the overlay ON: the curve spans the two stamped bars and the
    // right axis reads the 2s peak (jsdom's zero-width viewport keeps the whole-log scale, adaptive off anyway).
    assert.ok(msBtn().className.includes('lc-gran-on'), 'on at mount (the settings default)')
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-top')), '2.0s')
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-mid')), '1.0s')

    await click(msBtn())
    assert.ok(!msBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    assert.equal(queryAll(m.container, '.lc-axis-r').length, 0)

    await click(msBtn())
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)
    assert.equal(queryAll(m.container, '.lc-axis-r').length, 1)
    await m.unmount()
  })

  test('the trend card\'s DNA toggle fingerprints the bars, combinable with Delta', async () => {
    const m = await mountRich('sv-trend-dna')
    const dnaBtn = () => buttonByText(m.container, DICT_EN['trend.dna'])
    assert.ok(!dnaBtn().className.includes('lc-gran-on'), 'off at mount')
    const dnaGroup = dnaBtn().parentElement as HTMLElement
    assert.ok(dnaGroup.className.includes('lc-trend-mods'))
    assert.equal(dnaBtn().getAttribute('title'), DICT_EN['trend.dnaTip'])
    assert.equal(dnaBtn().nextElementSibling, buttonByText(m.container, DICT_EN['trend.adaptive']), 'DNA rides left of the adaptive switch')

    await click(dnaBtn())
    assert.ok(dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 3)
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')

    // The strip reads in the model's read order: the tool schema leads, then the messages by seq.
    const g = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna').style.background
    const amberAt = g.indexOf('color-amber-500')
    const greenAt = g.indexOf('color-green-500')
    const blueAt = g.indexOf('color-blue-500')
    const tealAt = g.indexOf('color-teal-500')
    assert.ok(amberAt >= 0 && greenAt > amberAt && blueAt > greenAt && tealAt > blueAt, g)

    // DNA + Delta: the mode switch stays live and each bar diffs its bands against the previous
    // one — the first bar carries no change (no strip), the axis turns signed around a zero line.
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 2)
    assert.ok(text(query(m.container, '.lc-axis-mid')).includes('0'), 'the delta zero line label rides the axis')

    await click(dnaBtn())
    assert.ok(!dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 0)
    assert.ok(queryAll(m.container, '.lc-bar-up').length > 0, 'delta arms are back')
    await m.unmount()
  })

  test('the trend and browser DNA toggles move as one', async () => {
    const m = await mountRich('sv-dna-link')
    const trendDna = () => buttonByText(m.container, DICT_EN['trend.dna'])
    const browserDna = () => query(m.container, '.lc-br-dna-ctl .lc-gran-btn')
    assert.ok(!trendDna().className.includes('lc-gran-on') && !browserDna().className.includes('lc-gran-on'), 'both off at mount')

    await click(trendDna())
    assert.ok(browserDna().className.includes('lc-gran-on'), 'the browser follows the trend toggle')
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 1)

    await click(browserDna())
    assert.ok(!trendDna().className.includes('lc-gran-on'), 'the trend follows the browser toggle')
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 0)
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 0)
    await m.unmount()
  })

  test('clicking a DNA band reveals that item in the Context browser', async () => {    const m = await mountRich('sv-dna-reveal')
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    // Give the strip a real 112px stack area, then click its very top: the hit is the LAST band of
    // bar seq 4 — the 'file output' tool result (system and the header lead the strip below it).
    const dnaDiv = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna')
    dnaDiv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 14, bottom: 112, width: 14, height: 112, x: 0, y: 0, toJSON: () => null }) as DOMRect
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    await flush()
    // The browser left the live surface for the bar's step and opened the node's row — the pin
    // alone would only select the step (accordion reset), so the open row is the reveal.
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))
    await m.unmount()
  })

  test('delta mode pairs the detail with the previous record; first bar has none', async () => {
    const m = await mountRich('sv-delta')
    const chart = query(m.container, '.lc-chart')
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    // Default active bar is the newest: detail is the signed change vs its predecessor.
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    // Hovering the FIRST bar pairs it with null (change from zero).
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="2"]').className.includes('lc-bar-hovered'))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await m.unmount()
  })

  test('event-kind filter narrows, unions, drops, and resets', async () => {
    const m = await mountRich('sv-kinds')
    const countEvents = () => queryAll(m.container, '.lc-event').length
    const kindBtn = (k: string) => query(m.container, `.lc-kinds [data-kind="${k}"]`) as HTMLElement
    assert.equal(countEvents(), 2)
    // The buttons carry their per-kind tallies (richTimeline: 1 inject, 1 compaction, 0 prunes).
    assert.deepEqual(
      queryAll(m.container, '.lc-kinds .lc-kind-n').map(el => text(el)),
      ['1', '1', '0'],
    )

    await click(kindBtn('inject'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 2)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('inject'))
    assert.equal(countEvents(), 2)
    await m.unmount()
  })
})
