/**
 * Note: the 'trend.empty' panel and the defaultGranularity/defaultTrendMode settings reads live in the PARENT
 * (contextView.tsx); TrendChart itself always renders the chart frame, so the empty-history arm is asserted as an
 * empty frame here.
 */

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { RISE_CAP, aggregateByTurn } from '../../../src/client/components/trendChart'
import { CATS } from '../../../src/client/categories'
import type { TrendBand } from '../../../src/client/dna'
import type { RequestRecord } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover } from '../helpers/kit'
import { CHART_H, TrendChart, assertColor, bars, kit, makeSpies, propsOf, req } from './trendChartHarness'

describe('TrendChart empty history', () => {
  test('renders the chart frame with no bars and no turn blocks', async () => {
    // The 'trend.empty' placeholder is the parent's (contextView) render arm; with zero requests the chart itself
    // renders an empty frame: unit axis (maxTotal floors at 1), empty scroll content, empty turn strip.
    const m = await mount(h(TrendChart, propsOf([])))
    assert.equal(bars(m.container).length, 0)
    assert.equal(queryAll(m.container, '.lc-turn').length, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(m.container, '.lc-grid-mid'), 'total mode keeps the dashed mid grid')
    assert.ok(query(m.container, '.lc-grid-q3'), 'total mode keeps the dashed quarter guides')
    assert.ok(query(m.container, '.lc-grid-q1'), 'total mode keeps the dashed quarter guides')
    assert.ok(query(m.container, '.lc-grid-zero'), 'total mode draws the solid zero baseline at the chart floor')
    await m.unmount()
  })
})

describe('TrendChart entrance rise cap', () => {
  test('a log longer than the cap rises only over its newest columns', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < RISE_CAP + 10; i++) reqs.push(req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const stacks = queryAll(m.container, '.lc-bar-stack')
    assert.equal(stacks.length, RISE_CAP + 10)
    const risers = stacks.filter(s => s.className.includes('animate-lc-bar-in'))
    assert.equal(risers.length, RISE_CAP)
    // The window is what rises: every column from its edge on, none before it.
    assert.deepEqual(stacks.slice(0, 10).map(s => s.className.includes('animate-lc-bar-in')), new Array<boolean>(10).fill(false))
    assert.deepEqual(stacks.slice(10).map(s => s.className.includes('animate-lc-bar-in')), new Array<boolean>(RISE_CAP).fill(true))
    // The window's own cascade counts from its edge — raw indices would all sit past the stagger cap and rise in unison.
    assert.equal(stacks[10].style.getPropertyValue('--lc-i'), '0')
    await m.unmount()
  })

  test('a log that fits the cap keeps its full cascade', async () => {
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const m = await mount(h(TrendChart, propsOf(reqs)))
    assert.deepEqual(queryAll(m.container, '.lc-bar-stack').map(s => s.className.includes('animate-lc-bar-in')), [true, true, true])
    await m.unmount()
  })

  test('the DNA and DNA+delta interiors obey the same cap', async () => {
    // A band that grows by one token per bar, so the DNA+delta arms exist for every bar but the first.
    const reqs: RequestRecord[] = []
    const bands: TrendBand[][] = []
    for (let i = 0; i < RISE_CAP + 5; i++) {
      const tokens = 100 + i
      reqs.push(req(i + 1, { turn: 1, step: i, total: tokens }))
      bands.push([{ key: 'sys', cat: 'system', tokens, off: 0, color: '#123456' } as TrendBand])
    }
    const total = await mount(h(TrendChart, propsOf(reqs, { dna: bands })))
    const totalDivs = queryAll(total.container, '.lc-bar-dna')
    assert.equal(totalDivs.length, RISE_CAP + 5)
    assert.equal(totalDivs.filter(d => d.className.includes('animate-lc-bar-in')).length, RISE_CAP)
    await total.unmount()
    // The first bar carries no baseline, so its delta arm renders nothing at all.
    const delta = await mount(h(TrendChart, propsOf(reqs, { dna: bands, mode: 'delta' })))
    const deltaDivs = queryAll(delta.container, '.lc-bar-dna')
    assert.equal(deltaDivs.length, RISE_CAP + 4)
    assert.equal(deltaDivs.filter(d => d.className.includes('animate-lc-bar-in')).length, RISE_CAP)
    await delta.unmount()
  })
})

describe('TrendChart step granularity, total mode', () => {
  test('stacks per-category segments in CATS order with real colors and proportional px heights', async () => {
    const r1 = req(1, { turn: 1, step: 0, skill: 40, total: 340 })
    const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, skill: 60, assistant: 80, tool: 120, total: 660 })
    const r3 = req(3, { turn: undefined, step: 0, user: 0, total: 280 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    assert.deepEqual(bs.map(b => b.getAttribute('data-seq')), ['1', '2', '3'])

    // Seven priced categories, in CATS order, with the shipped colors; max bar segments scale against maxTotal=660.
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 7)
    for (let i = 0; i < CATS.length; i++) assertColor(segs1[i].style.background, CATS[i].color)
    assert.equal(segs1[0].style.height, `${Math.round(100 / 660 * CHART_H)}px`)
    assert.equal(segs1[4].style.height, `${Math.round(40 / 660 * CHART_H)}px`)
    assert.equal(segs1[6].style.height, `${Math.round(60 / 660 * CHART_H)}px`)
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs2[0].style.height, `${Math.round(200 / 660 * CHART_H)}px`)

    // Zero-value categories are skipped entirely (r3.user = 0 → five segments, no user-green segment).
    const segs3 = queryAll(bs[2], '.lc-bar-stack > div')
    assert.equal(segs3.length, 5)
    assert.ok(![...segs3].some(s => s.style.background.includes('var(--color-green-500)')))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '660')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '495')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '330')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '165')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')

    // Turn strip: turn 1 spans two step columns (2*16-2 = 30px), the turnless request lands in group 0 (14px);
    // zebra fills alternate and stay disjoint from the category palette.
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].style.width, '30px')
    assert.equal(turns[1].style.width, '14px')
    assert.ok(turns[0].style.background.includes('var(--color-neutral-500) 12%'))
    assert.ok(turns[1].style.background.includes('var(--color-neutral-500) 26%'))
    assert.deepEqual(turns.map(t => t.textContent), ['1', '0'])
    await m.unmount()
  })

  test('plots raw fold figures: the provider prompt never rescales the stack, so constant categories stay flat', async () => {
    const composition = { system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 }
    const r1 = req(1, { turn: 1, step: 0, ...composition })
    const r2 = req(2, { turn: 1, step: 1, ...composition, prompt: 1200 })
    const r3 = req(3, { turn: 2, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 500 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    // maxTotal follows the heuristic totals (600), not the provider prompt (1200).
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    // Identical compositions plot IDENTICAL segment heights regardless of the reported prompt — a constant
    // system prompt must not ride the provider/heuristic ratio (that per-request rescale faked growth into
    // categories the fold never changed).
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs1.length, 6)
    assert.deepEqual(segs2.map(s => s.style.height), segs1.map(s => s.style.height))
    assert.equal(segs1[0].style.height, `${Math.round(200 / 600 * CHART_H)}px`)
    // A usage-only record (prompt without messages) still renders no segments.
    assert.equal(queryAll(bs[2], '.lc-bar-stack > div').length, 0)

    // The tip is placed over its bar's visible slice imperatively (transform, not `left`), so it never
    // contributes to the scroller's overflow — see the overlay test below.
    const { spies, handlers } = makeSpies()
    await m.update(h(TrendChart, { ...propsOf([r1, r2, r3]), ...handlers, hoveredSeq: 2 }))
    const tip = query(m.container, '.lc-chart-tip')
    // Rows: identity, then the SAME total the bar is drawn against (the heuristic 600, not the prompt 1200).
    assert.deepEqual(
      queryAll(tip, 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 1, n: 2 }), kit.t('tip.total', { n: '600' })],
    )
    assert.equal(tip.style.transform, 'translate(23px, 0)') // idx 1 * 16 + BAR_W/2, scrollLeft 0
    assert.ok(spies.hover.length === 0, 'hover callback only fires from real mouseover')
    await m.unmount()
  })

  test('a zero-only history keeps the unit scale (maxTotal floors at 1)', async () => {
    const zero = req(1, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const m = await mount(h(TrendChart, propsOf([zero])))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1')
    assert.equal(queryAll(bars(m.container)[0], '.lc-bar-stack > div').length, 0)
    await m.unmount()
  })
})

describe('TrendChart delta mode', () => {
  const base = req(1, { turn: 1, step: 0 })
  const grown = req(2, { turn: 1, step: 1, system: 110, tools: 60, user: 40, inject: 30, assistant: 50, tool: 70, total: 360 })
  const shrunk = req(3, { turn: 2, step: 0, system: 90, tools: 40, user: 20, inject: 10, assistant: 30, tool: 50, total: 240 })
  const zeroReq = req(9, { turn: 3, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })

  test('diverging stacks pile positive deltas up and hang negatives down off a solid zero line', async () => {
    const m = await mount(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta' })))

    // maxUp=60 (grown: +10 x6), maxDown=120 (shrunk: -20 x6) → scale 112/180, zero line at upPx=37.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+60')
    // Quarter marks sit on the uniform scale: +15 above (height ¼), -75 below (height ¾). The +15 mark's
    // label box (top 41) is 9px from the zero label's (13+37=50) — under one 11px label height — so it
    // drops itself instead of overlapping the zero reference; the -75 mark stays.
    assert.equal(queryAll(m.container, '.lc-axis-q3').length, 0)
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '-75')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 37}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-120')
    assert.equal(query(m.container, '.lc-grid-zero').style.top, `${18 + 37}px`)
    // Each surviving quarter mark keeps its dashed guide; the mark that yielded to the zero label drops it too.
    assert.equal(queryAll(m.container, '.lc-grid-q3').length, 0)
    assert.ok(query(m.container, '.lc-grid-q1'))

    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-bar-up > div').length, 0)
    assert.equal(queryAll(bs[0], '.lc-bar-down > div').length, 0)
    const up2 = queryAll(bs[1], '.lc-bar-up > div')
    assert.equal(up2.length, 6)
    assert.equal(up2[0].style.height, `${Math.round(10 * CHART_H / 180)}px`)
    assertColor(up2[0].style.background, CATS[0].color)
    assert.equal(queryAll(bs[1], '.lc-bar-down > div').length, 0)
    const down3 = queryAll(bs[2], '.lc-bar-down > div')
    assert.equal(down3.length, 6)
    assert.equal(down3[0].style.height, `${Math.round(20 * CHART_H / 180)}px`)
    assert.equal(queryAll(bs[2], '.lc-bar-up > div').length, 0)
    // The up stack rides downPx up from the bottom, the down stack hangs upPx from the zero line.
    assert.equal(query(bs[1], '.lc-bar-up').style.bottom, '75px')
    assert.equal(query(bs[2], '.lc-bar-down').style.top, '37px')

    // Delta tooltip: signed net change on the metric row, '+' only for positive nets.
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 2 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 1, n: 2 }), kit.t('tip.delta', { n: '+60' })],
    )
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 3 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '-120' })))
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 1 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '0' })))
    await m.unmount()
  })

  test('growth-only history zeroes the negative axis arm; shrink-only zeroes the positive arm', async () => {
    const up = await mount(h(TrendChart, propsOf([zeroReq, base], { mode: 'delta' })))
    assert.equal(query(up.container, '.lc-axis-top').textContent, '+300')
    // Zero line pinned to the chart bottom (upPx 112) clears both quarter marks: +225 / +75.
    assert.equal(query(up.container, '.lc-axis-q3').textContent, '+225')
    assert.equal(query(up.container, '.lc-axis-q1').textContent, '+75')
    assert.equal(query(up.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(up.container, '.lc-grid-q3'))
    assert.ok(query(up.container, '.lc-grid-q1'))
    const upSegs = queryAll(bars(up.container)[1], '.lc-bar-up > div')
    assert.equal(upSegs.length, 6)
    assert.equal(upSegs[0].style.height, `${Math.round(100 * CHART_H / 300)}px`)
    await up.unmount()

    const down = await mount(h(TrendChart, propsOf([base, zeroReq], { mode: 'delta' })))
    // Zero line pinned to the chart top (upPx 0): the quarter marks read -75 / -225.
    assert.equal(query(down.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(down.container, '.lc-axis-q3').textContent, '-75')
    assert.equal(query(down.container, '.lc-axis-q1').textContent, '-225')
    assert.equal(query(down.container, '.lc-axis-bot').textContent, '-300')
    assert.ok(query(down.container, '.lc-grid-q3'))
    assert.ok(query(down.container, '.lc-grid-q1'))
    assert.equal(queryAll(bars(down.container)[1], '.lc-bar-down > div').length, 6)
    await down.unmount()
  })

  test('a quarter mark landing on the zero label drops itself; the opposite mark keeps its place', async () => {
    // maxUp=90 (+90 system), maxDown=30 (-30 tools) → upPx 84: the zero label (top 97) sits exactly on the
    // ¼-height mark (top 97), which drops itself; the ¾-height mark renders +60 well clear of it.
    const flat = req(1, { turn: 1, step: 0, system: 0, tools: 30, user: 0, inject: 0, assistant: 0, tool: 0, total: 30 })
    const mixed = req(2, { turn: 1, step: 1, system: 90, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 90 })
    const m = await mount(h(TrendChart, propsOf([flat, mixed], { mode: 'delta' })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+90')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '+60')
    assert.equal(queryAll(m.container, '.lc-axis-q1').length, 0)
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 84}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-30')
    assert.ok(query(m.container, '.lc-grid-q3'))
    assert.equal(queryAll(m.container, '.lc-grid-q1').length, 0)
    await m.unmount()
  })
})

describe('TrendChart turn granularity', () => {
  const t1s0 = req(1, { turn: 1, step: 0 })
  const t1s1 = req(2, { turn: 1, step: 1, total: 360 })
  const t2s0 = req(3, { turn: 2, step: 0, total: 280 })

  test('turn aggregates render one bar per turn with aggregated labels and turn-count tooltips', async () => {
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const bs = bars(m.container)
    assert.equal(bs.length, 2)
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    // Aggregated groups always occupy exactly one column.
    assert.deepEqual(turns.map(t => t.style.width), ['14px', '14px'])
    assert.deepEqual(turns.map(t => t.textContent), ['1', '2'])

    // Multi-step aggregate → tip.turn; a single-step aggregate still speaks TURN (the step-count wording), never the step index.
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t1s1.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 1, n: 2 })))
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t2s0.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 2 })))
    await m.unmount()

    // A multi-step aggregate of TURNLESS requests reports turn 0.
    const turnless = aggregateByTurn([req(10, { turn: undefined }), req(11, { turn: undefined })])
    const m2 = await mount(h(TrendChart, propsOf(turnless, { granularity: 'turn', hoveredSeq: 11 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 0, n: 2 })))
    await m2.unmount()

    // A turn-mode record missing stepCount (the parent always aggregates, so this is defensive) degrades to 1 step;
    // a missing turn field degrades to turn 0 the same way.
    const m3 = await mount(h(TrendChart, propsOf([req(20, { turn: undefined, step: 3 })], { granularity: 'turn', hoveredSeq: 20 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 0 })))
    await m3.unmount()
  })

  test('turn strip hover/click drive the turn callbacks; activeTurn dims the chart and lights the block', async () => {
    const { spies, handlers } = makeSpies()
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn' })))

    const turns = queryAll(m.container, '.lc-turn')
    await hover(turns[0])
    assert.deepEqual(spies.hoverTurn, [1])
    await click(turns[1])
    assert.deepEqual(spies.pickTurn, [2])
    await unhover(turns[0])
    assert.deepEqual(spies.hoverTurn, [1, null])

    await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', activeTurn: 1 })))
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    const bs = bars(m.container)
    assert.ok(bs[0].className.includes('lc-bar-in-turn'))
    assert.ok(!bs[1].className.includes('lc-bar-in-turn'))
    assert.ok(queryAll(m.container, '.lc-turn')[0].className.includes('lc-turn-on'))
    assert.ok(!queryAll(m.container, '.lc-turn')[1].className.includes('lc-turn-on'))

    await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', activeTurn: null })))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    assert.ok(!bars(m.container)[0].className.includes('lc-bar-in-turn'))
    await m.unmount()
  })
})

describe('TrendChart step flags', () => {
  test('every 5th step bar plants a flag labeled with its cumulative step number', async () => {
    const reqs = Array.from({ length: 12 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const flags = queryAll(m.container, '.lc-step-flag')
    assert.equal(flags.length, 2)
    // Single- and multi-digit labels alike; the flag rides its bar (5th and 10th columns).
    assert.deepEqual(flags.map(f => f.textContent), ['5', '10'])
    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-step-flag').length, 0)
    assert.ok(query(bs[4], '.lc-step-flag'))
    assert.ok(query(bs[9], '.lc-step-flag'))
    await m.unmount()
  })

  test('delta mode keeps the flags; turn granularity plants none (the turn strip numbers that grid)', async () => {
    const reqs = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta' })))
    assert.deepEqual(queryAll(m.container, '.lc-step-flag').map(f => f.textContent), ['5'])
    await m.unmount()

    const turns = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: i + 1, step: 0 }))
    const m2 = await mount(h(TrendChart, propsOf(aggregateByTurn(turns), { granularity: 'turn' })))
    assert.equal(queryAll(m2.container, '.lc-step-flag').length, 0)
    await m2.unmount()
  })
})
