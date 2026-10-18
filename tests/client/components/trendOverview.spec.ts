// The trend card's overview face: total/delta ribbon geometry, quartile-only flags, the shared hover/tip flow,
// and the proportional turn strip. jsdom layout rides the shared trendChart harness (clientWidth 400).

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { aggregateByTurn } from '../../../src/client/components/trendChart'
import { makeTrendOverview, type TrendOverviewProps } from '../../../src/client/components/trendOverview'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover } from '../helpers/kit'
import { kit, req } from './trendChartHarness'

const TrendOverview = makeTrendOverview(kit)

function propsOf(requests: RequestRecord[], over: Partial<TrendOverviewProps> = {}): TrendOverviewProps {
  return {
    requests,
    markers: requests.map(() => undefined),
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    hoverCat: null,
    onSelect: () => {},
    onHover: () => {},
    onHoverTurn: () => {},
    onPickTurn: () => {},
    ...over,
  }
}

/** jsdom has no layout: give the fit surface a real 400px plot so pointer fractions read true. */
function stubSurfaceRect(el: HTMLElement, width = 400): void {
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: width, bottom: 130, width, height: 130, x: 0, y: 0, toJSON: () => null }) as DOMRect
}

async function moveX(el: HTMLElement, clientX: number): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX })) })
}

async function clickX(el: HTMLElement, clientX: number): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX })) })
}

describe('TrendOverview total-mode ribbon', () => {
  const r1 = req(1, { turn: 1, step: 0 })
  const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 })

  test('stacks exact bands between adjacent cumulates; zero-width categories drop', async () => {
    const m = await mount(h(TrendOverview, propsOf([r1, r2])))
    const svg = query(m.container, '.lc-fit-svg')
    assert.match(svg.getAttribute('class')!, /\blc-bar-in\b/)
    assert.match(svg.getAttribute('class')!, /\blc-duration\b/)
    assert.equal(svg.getAttribute('viewBox'), '0 0 1 112')
    assert.equal(svg.getAttribute('preserveAspectRatio'), 'none')
    const polys = queryAll(svg, 'polygon')
    assert.deepEqual(polys.map(p => p.getAttribute('data-cat')), ['system', 'tools', 'user', 'inject', 'assistant', 'tool'])
    assert.equal(polys[0].getAttribute('points'), '0,93.33 1,74.67 1,112 0,112')
    assert.equal(polys[1].getAttribute('points'), '0,84 1,56 1,74.67 0,93.33')
    assert.equal(polys[5].getAttribute('points'), '0,56 1,0 1,22.4 0,67.2')
    assert.equal(polys[0].style.fill, 'var(--color-indigo-500)')
    assert.equal(polys[5].style.stroke, 'var(--color-teal-500)')
    // Whole-log quarter axis.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '450')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '300')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '150')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')
    await m.unmount()
  })

  test('a single record closes full-width bands and a lone turn labels itself', async () => {
    const m = await mount(h(TrendOverview, propsOf([r1])))
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 1 112')
    // One record's own scale: maxTotal 300, so the 100-token system band tops at 74.67.
    assert.equal(query(svg, 'polygon').getAttribute('points'), '0,74.67 1,74.67 1,112 0,112')
    assert.equal(query(m.container, '.lc-turn-label').textContent, '1')
    // The quartiles collapse onto the sole record; the interior filter plants no pole.
    assert.equal(queryAll(m.container, '.lc-step-flag').length, 0)
    await m.unmount()
  })

  test('an all-zero history keeps the unit axis and paints no ribbon', async () => {
    const zero = req(9, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const m = await mount(h(TrendOverview, propsOf([zero])))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1')
    assert.equal(queryAll(m.container, '.lc-fit-svg').length, 0)
    await m.unmount()
  })

  test('an empty list renders nothing', async () => {
    const m = await mount(h(TrendOverview, propsOf([])))
    assert.equal(m.container.firstElementChild, null)
    await m.unmount()
  })
})

describe('TrendOverview delta ribbon', () => {
  const base = req(1, { turn: 1, step: 0 })
  // r2 grows every category by exactly 8 (up churn 56), r3 replays the base (down churn 56): the 112px area
  // splits evenly, so px-per-token is 1 and every figure lands on a whole pixel.
  const grown = req(2, { turn: 1, step: 1, system: 108, tools: 58, user: 38, inject: 28, skill: 8, assistant: 48, tool: 68, total: 346 })

  test('splits grow/shrink around the proportional zero line; a lone record paints no bands', async () => {
    const lone = await mount(h(TrendOverview, propsOf([base], { mode: 'delta' })))
    assert.equal(queryAll(lone.container, '.lc-fit-svg').length, 0)
    assert.equal(query(lone.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(lone.container, '.lc-axis-bot').textContent, '0')
    await lone.unmount()

    const m = await mount(h(TrendOverview, propsOf([base, grown, base], { mode: 'delta' })))
    // The zero label rides the line at 13+56; the quarter marks clear it.
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 56}px`)
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '+28')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '-28')
    const polys = queryAll(m.container, 'polygon')
    assert.equal(polys.length, 14)
    const up = polys.find(p => p.getAttribute('data-cat') === 'system' && p.getAttribute('points')!.startsWith('0,56 1,48'))
    assert.ok(up !== undefined)
    assert.equal(up.getAttribute('points'), '0,56 1,48 2,56 2,56 1,56 0,56')
    const down = polys.find(p => p.getAttribute('data-cat') === 'system' && p.getAttribute('points')!.endsWith('2,64 1,56 0,56'))
    assert.ok(down !== undefined)
    assert.equal(down.getAttribute('points'), '0,56 1,56 2,56 2,64 1,56 0,56')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+56')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-56')
    await m.unmount()
  })

  test('a quarter mark yields entirely when its label box would overlap the zero label', async () => {
    const heavy = req(1, { turn: 1, step: 0, system: 400, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360, total: 2490 })
    // +140 up, then −560 down: the zero line sits at 13+22, colliding with the q3 mark.
    const upSmall = req(2, { turn: 1, step: 1, system: 540, total: 2630, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const downBig = req(3, { turn: 2, step: 0, system: 340, tools: 290, user: 270, inject: 260, skill: 250, assistant: 280, tool: 300, total: 1990 })
    const m1 = await mount(h(TrendOverview, propsOf([heavy, upSmall, downBig], { mode: 'delta' })))
    assert.equal(query(m1.container, '.lc-axis-mid').style.top, `${13 + 22}px`)
    assert.equal(queryAll(m1.container, '.lc-axis-q3').length, 0)
    assert.equal(queryAll(m1.container, '.lc-grid-q3').length, 0)
    assert.equal(query(m1.container, '.lc-axis-q1').textContent, '-385')
    await m1.unmount()

    // +420 up, then −140 down: the zero line rides the q1 mark instead.
    const upBig = req(2, { turn: 1, step: 1, system: 820, total: 2910, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const downSmall = req(3, { turn: 2, step: 0, system: 760, tools: 270, total: 2690, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const m2 = await mount(h(TrendOverview, propsOf([heavy, upBig, downSmall], { mode: 'delta' })))
    assert.equal(query(m2.container, '.lc-axis-mid').style.top, `${13 + 84}px`)
    assert.equal(queryAll(m2.container, '.lc-axis-q1').length, 0)
    assert.equal(queryAll(m2.container, '.lc-grid-q1').length, 0)
    assert.equal(query(m2.container, '.lc-axis-q3').textContent, '+280')
    await m2.unmount()
  })
})

describe('TrendOverview duration overlay', () => {
  const reqs = [
    req(1, { turn: 1, step: 0, activeMs: 1000 }),
    req(2, { turn: 1, step: 1 }),
    req(3, { turn: 1, step: 2, activeMs: 2000 }),
    req(4, { turn: 1, step: 3, activeMs: 500 }),
  ]

  test('the curve rides record positions, breaks on missing stamps, dots lone points', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 3 112')
    const lines = queryAll(svg, 'polyline:not(.lc-dur-halo)')
    // [r3, r4] bridges the missing r2 stamp; r1 stands alone as a dot.
    assert.equal(lines.length, 1)
    assert.equal(lines[0].getAttribute('points'), '2,0 3,84')
    // One run's halo polyline + one dot's halo circle.
    assert.equal(queryAll(svg, '.lc-dur-halo').length, 2)
    const dot = queryAll(svg, 'circle').find(c => c.getAttribute('r') === '2')
    assert.ok(dot !== undefined)
    assert.equal(dot.getAttribute('cx'), '0')
    assert.equal(dot.getAttribute('cy'), '56')
    // The right-hand duration axis keeps its quartiles.
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-q1').textContent, '500ms')
    await m.unmount()
  })

  test('no stamps: bands still paint, the curve is absent, the axis dashes', async () => {
    const m = await mount(h(TrendOverview, propsOf([req(1), req(2)], { durationCurve: true })))
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '—')
    assert.equal(queryAll(m.container, 'polyline').length, 0)
    assert.equal(queryAll(m.container, 'polygon').length, 6)
    await m.unmount()
  })
})

describe('TrendOverview category focus', () => {
  test('plots the focused band rescaled to its own max; an unknown key degrades', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, tool: 120, total: 600 })
    const m = await mount(h(TrendOverview, propsOf([r1, r2], { focusCat: 'tool' })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '120')
    const polys = queryAll(m.container, 'polygon')
    assert.equal(polys.length, 1)
    assert.equal(polys[0].getAttribute('data-cat'), 'tool')
    assert.equal(polys[0].getAttribute('points'), '0,56 1,0 1,112 0,112')
    await m.unmount()

    const m2 = await mount(h(TrendOverview, propsOf([r1, r2], { focusCat: 'nope' })))
    assert.equal(query(m2.container, '.lc-axis-top').textContent, '600')
    assert.equal(queryAll(m2.container, 'polygon').length, 6)
    await m2.unmount()
  })
})

describe('TrendOverview flags and markers', () => {
  function steps(count: number, perTurn = 1): RequestRecord[] {
    const out: RequestRecord[] = []
    for (let i = 1; i <= count; i++) out.push(req(i, { turn: Math.ceil(i / perTurn), step: (i - 1) % perTurn }))
    return out
  }

  test('plants poles at the record quartiles and the full span (step granularity)', async () => {
    const m = await mount(h(TrendOverview, propsOf(steps(47))))
    const flags = queryAll(m.container, '.lc-step-flag')
    assert.equal(flags.length, 4)
    const idx = [12, 23, 35]
    flags.slice(0, 3).forEach((f, i) => assert.ok(Math.abs(parseFloat(f.style.left) - idx[i] / 46 * 100) < 1e-9, f.style.left))
    // The full-span pole hugs inside the pane's right edge (left 100% falls wholly past the scroller's clip).
    assert.equal(flags[3].style.left, 'calc(100% - 1px)')
    assert.deepEqual(flags.map(f => query(f, '.lc-step-flag-label').textContent), ['13', '24', '36', '47'])
    await m.unmount()
  })

  test('short logs keep the collapsed-at-start pole out but keep the full-span pole', async () => {
    // Two records: the mid quartiles collapse; only the full-span pole survives, at the right edge.
    const two = await mount(h(TrendOverview, propsOf(steps(2))))
    const flag = query(two.container, '.lc-step-flag')
    assert.equal(query(flag, '.lc-step-flag-label').textContent, '2')
    assert.equal(flag.style.left, 'calc(100% - 1px)')
    await two.unmount()
    // Three records: the interior ½ pole and the full-span pole.
    const three = await mount(h(TrendOverview, propsOf(steps(3))))
    const flags = queryAll(three.container, '.lc-step-flag')
    assert.deepEqual(flags.map(f => query(f, '.lc-step-flag-label').textContent), ['2', '3'])
    assert.equal(flags[0].style.left, '50%')
    await three.unmount()
    // The sole record IS both edges: no pole (its label would hang past the left clip).
    const one = await mount(h(TrendOverview, propsOf([req(1, { turn: 1, step: 0 })])))
    assert.equal(queryAll(one.container, '.lc-step-flag').length, 0)
    await one.unmount()
  })

  test('turn granularity skips the poles and labels the strip quartiles plus the full span (by width)', async () => {
    const m = await mount(h(TrendOverview, propsOf(steps(10, 2), { granularity: 'turn' })))
    assert.equal(queryAll(m.container, '.lc-step-flag').length, 0)
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['2', '3', '4', '5'])
    const blocks = queryAll(m.container, '.lc-turn')
    assert.equal(blocks.length, 5)
    assert.equal(blocks[0].style.flexGrow, '2')
    await m.unmount()
  })

  test('a wide tail turn carries every strip quartile its width holds, despite the group count', async () => {
    const reqs = [
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 2, step: 0 }),
      ...Array.from({ length: 50 }, (_, i) => req(3 + i, { turn: 3, step: i })),
    ]
    const m = await mount(h(TrendOverview, propsOf(reqs)))
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['3'])
    await m.unmount()
  })

  test('markers carry the positioned scissors with the event title', async () => {
    const reqs = steps(3, 2)
    const compaction: ContextEventRecord = { seq: 2, time: 1700000000000, kind: 'compaction', count: 5, fromTurn: 1, fromStep: 0, turn: 1, step: 1 }
    const prune: ContextEventRecord = { seq: 3, time: 1700000060000, kind: 'prune' }
    const markers = [undefined, compaction, prune]
    const m = await mount(h(TrendOverview, propsOf(reqs, { markers })))
    const glyphs = queryAll(m.container, '.lc-bar-marker')
    assert.equal(glyphs.length, 2)
    assert.equal(glyphs[0].textContent, '✂')
    assert.equal(glyphs[0].style.left, '50%')
    assert.equal(
      glyphs[0].getAttribute('title'),
      '✂ ' + kit.t('events.range', { t: 1, a: 0, b: 1 }) + ' — ' + kit.t('ev.compaction', { n: 5 }),
    )
    assert.equal(glyphs[1].style.left, '100%')
    assert.equal(glyphs[1].getAttribute('title'), '✂ ' + kit.t('ev.prune'))
    await m.unmount()
  })

  test('the shared category hover rides the container attribute', async () => {
    const reqs = steps(4, 2)
    const m = await mount(h(TrendOverview, propsOf(reqs, { hoverCat: 'tools' })))
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    await m.update(h(TrendOverview, propsOf(reqs)))
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    await m.unmount()
  })
})

describe('TrendOverview pointer interaction', () => {
  const reqs = [1, 2, 3, 4, 5].map(i => req(i, { turn: 1, step: i - 1 }))

  test('mousemove picks the nearest record, dedupes repeats, and clears on leave', async () => {
    const spies = { select: [] as (number | null)[], hover: [] as (number | null)[], hoverTurn: [] as (number | null)[], pickTurn: [] as number[] }
    const m = await mount(h(TrendOverview, propsOf(reqs, {
      onSelect: (s) => { spies.select.push(s) },
      onHover: (s) => { spies.hover.push(s) },
      onHoverTurn: (t) => { spies.hoverTurn.push(t) },
      onPickTurn: (t) => { spies.pickTurn.push(t) },
    })))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    // fx .5 → the middle record; a sub-half-step drift stays put; the far edge clamps to the last; x<0 to the first.
    await moveX(surface, 200)
    await moveX(surface, 210)
    await moveX(surface, 399)
    await moveX(surface, -100)
    assert.deepEqual(spies.hover, [3, 5, 1])
    await unhover(surface)
    assert.deepEqual(spies.hover, [3, 5, 1, null])
    await m.unmount()
  })

  test('a zero-width rect picks the first record', async () => {
    const spies = { hover: [] as (number | null)[] }
    const m = await mount(h(TrendOverview, propsOf(reqs, { onHover: (s) => { spies.hover.push(s) } })))
    await moveX(query(m.container, '.lc-chart'), 300)
    assert.deepEqual(spies.hover, [1])
    await m.unmount()
  })

  test('clicking the surface toggles the pinned record', async () => {
    const spies = { select: [] as (number | null)[] }
    const handlers = { onSelect: (s: number | null) => { spies.select.push(s) } }
    const m = await mount(h(TrendOverview, propsOf(reqs, handlers)))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    await clickX(surface, 200)
    assert.deepEqual(spies.select, [3])
    await m.update(h(TrendOverview, propsOf(reqs, { ...handlers, selectedSeq: 3 })))
    await clickX(surface, 200)
    assert.deepEqual(spies.select, [3, null])
    await m.update(h(TrendOverview, propsOf(reqs, handlers)))
    await clickX(surface, 10)
    assert.deepEqual(spies.select, [3, null, 1])
    await m.unmount()
  })

  test('the hovered record drives the tip, the brand rule, and the selection pin', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs)))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    assert.equal(queryAll(m.container, '.lc-fit-cursor').length, 0)

    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 3 })))
    const tip = query(m.container, '.lc-chart-tip')
    assert.deepEqual(queryAll(tip, 'span').map(r => r.textContent), [
      kit.t('tip.step', { t: 1, s: 2, n: 5 }),
      kit.t('tip.total', { n: '300' }),
    ])
    // jsdom tips measure 0 wide, so the clamp is pure x: idx 2 of u 4 over the 400px wrap → 200.
    assert.equal(tip.style.transform, 'translate(200px, 0)')
    const cursor = query(m.container, '.lc-fit-cursor')
    assert.equal(cursor.style.left, '50%')

    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 3, selectedSeq: 1 })))
    const cursors = queryAll(m.container, '.lc-fit-cursor')
    assert.equal(cursors.length, 2)
    assert.match(cursors[0].className, /lc-fit-cursor/)
    assert.match(cursors[1].className, /lc-fit-pin/)
    assert.equal(cursors[1].style.left, '0%')

    // Unknown hovered AND selected records leave neither rule behind.
    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 999, selectedSeq: 999 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    assert.equal(queryAll(m.container, '.lc-fit-cursor').length, 0)
    await m.unmount()
  })

  test('tip rows follow the granularity, mode, focus and duration state', async () => {
    // Turn granularity reads the aggregate's own stepCount: a two-step turn and a one-step turn.
    const aggs = aggregateByTurn([req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })])
    const m1 = await mount(h(TrendOverview, propsOf(aggs, { granularity: 'turn', hoveredSeq: 2 })))
    assert.deepEqual(queryAll(query(m1.container, '.lc-chart-tip'), 'span').map(r => r.textContent), [
      kit.t('tip.turn', { t: 1, n: 2 }),
      kit.t('tip.total', { n: '300' }),
    ])
    await m1.update(h(TrendOverview, propsOf(aggs, { granularity: 'turn', hoveredSeq: 3 })))
    assert.equal(query(query(m1.container, '.lc-chart-tip'), 'span').textContent, kit.t('tip.turn1', { t: 2 }))
    await m1.unmount()

    // Delta names the signed net change.
    const grew = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 })
    const m2 = await mount(h(TrendOverview, propsOf([req(1), grew], { mode: 'delta', hoveredSeq: 2 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '+300' })))
    await m2.update(h(TrendOverview, propsOf([grew, req(4)], { mode: 'delta', hoveredSeq: 4 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '-300' })))
    await m2.unmount()

    // Duration appends its row; focus names the category instead of claiming a total.
    const m3 = await mount(h(TrendOverview, propsOf([req(1, { activeMs: 2000 }), grew], { durationCurve: true, hoveredSeq: 1 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.duration', { n: '2.0s' })))
    await m3.update(h(TrendOverview, propsOf([req(1), grew], { focusCat: 'tool', hoveredSeq: 1 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.cat', { cat: kit.catLabel('tool'), n: '60' })))
    await m3.unmount()

    // A stepless record falls back to Turn 0 · Step 0.
    const m4 = await mount(h(TrendOverview, propsOf([req(9, { turn: undefined, step: undefined })], { hoveredSeq: 9 })))
    assert.equal(query(query(m4.container, '.lc-chart-tip'), 'span').textContent, kit.t('tip.step', { t: 0, s: 0, n: 1 }))
    await m4.unmount()
  })
})

describe('TrendOverview turn strip', () => {
  const reqs = [1, 2, 3, 4, 5, 6].map(i => req(i, { turn: Math.ceil(i / 3), step: (i - 1) % 3 }))

  test('the active turn washes the plot outside its range and relays strip hover and clicks', async () => {
    const spies = { hoverTurn: [] as (number | null)[], pickTurn: [] as number[] }
    const handlers = {
      onHoverTurn: (t: number | null) => { spies.hoverTurn.push(t) },
      onPickTurn: (t: number) => { spies.pickTurn.push(t) },
    }
    // Turn 1 = records [0..2] of 0..5: no left wash, the rest of the plot dimmed by the right one.
    const m = await mount(h(TrendOverview, propsOf(reqs, { activeTurn: 1, ...handlers })))
    assert.match(query(m.container, '.lc-chart-scroll').className, /lc-chart-dim/)
    const washes = queryAll(m.container, '.lc-fit-wash')
    assert.equal(washes.length, 2)
    assert.equal(washes[0].style.width, '0%')
    assert.equal(washes[1].style.width, '50%')
    assert.match(query(m.container, '.lc-turn').className, /lc-turn-on/)

    // Turn 2 = records [3..5]: half a step of left wash, the right edge clamps empty.
    await m.update(h(TrendOverview, propsOf(reqs, { activeTurn: 2, ...handlers })))
    const washes2 = queryAll(m.container, '.lc-fit-wash')
    assert.equal(washes2[0].style.width, '50%')
    assert.equal(washes2[1].style.width, '0%')
    assert.match(queryAll(m.container, '.lc-turn')[1].className, /lc-turn-on/)

    // An unknown turn matches nothing: no wash, no lit block — the plot keeps the dim (the bars' parity).
    await m.update(h(TrendOverview, propsOf(reqs, { activeTurn: 999, ...handlers })))
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 0)
    assert.equal(queryAll(m.container, '.lc-turn-on').length, 0)

    // Strip hover lights a turn; the click pins it; leaving the strip clears the hover.
    await hover(query(m.container, '.lc-turn'))
    assert.deepEqual(spies.hoverTurn, [1])
    await click(query(m.container, '.lc-turn'))
    assert.deepEqual(spies.pickTurn, [1])
    await unhover(query(m.container, '.lc-turns'))
    assert.deepEqual(spies.hoverTurn, [1, null])
    await m.unmount()
  })
})
