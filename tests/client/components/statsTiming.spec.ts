import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeStatsTiming } from '../../../src/client/components/statsTiming'
import type { TimingSpan, TimingTotals } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text, hover } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsTiming = makeStatsTiming(kit, Donut)
const StatsTimingZh = makeStatsTiming(kitZh, Donut)

/** Local HH:MM:SS exactly as the kit's fmtTime renders it (a timezone-free assertion). */
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

const TIMING: TimingTotals = {
  wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, calls: 10, toolsMs: 300_000, toolCalls: 25,
  tools: { bash: { calls: 15, ms: 200_000 }, read: { calls: 8, ms: 80_000 } },
}

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string; dim: boolean } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
    dim: row.className.includes('lc-sl-row-dim'),
  }
}

describe('StatsTiming', () => {
  test('absent and all-zero timings render the empty state', async () => {
    for (const timing of [null, { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }] as const) {
      const m = await mount(h(StatsTiming, { timing }))
      assert.ok(text(m.container).includes('No timing data yet'))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      await m.unmount()
    }
  })

  test('the donut center shows the wall total; rows lead with shares', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING }))
    assert.ok(text(m.container).includes('Timing Stats'))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10m0s')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Active Time')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: 'LLM Gen', count: '2m20s', dim: false })
    // The tools row keeps the true 5m sum even though the ring clamps it.
    assert.deepEqual(rowOf(m.container, 2), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    // Four ring segments painted (ttft + gen + tools + overhead); four rows.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 4)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    await m.unmount()
  })

  test('labels localize while durations stay locale-free', async () => {
    const m = await mount(h(StatsTimingZh, { timing: TIMING }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10m0s')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: '模型等待', count: '1m40s · 10次', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: '模型生成', count: '2m20s', dim: false })
    await m.unmount()
  })

  test('parallel tool overlap: the count keeps the true sum, the share caps at 100%', async () => {
    // 9 parallel 22s calls inside a 100s wall: tools sum 200s > wall.
    const timing: TimingTotals = { wallMs: 100_000, ttftMs: 25_000, genMs: 35_000, calls: 2, toolsMs: 200_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 2), { pct: '100.0%', label: 'Tool runs', count: '3m20s · 9 runs', dim: false })
    // The ring clamps tools into the 40s post-model window; the zero overhead
    // slice paints no arc AND its legend row is omitted: 3 circles, 3 rows.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 3)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[2])
    assert.ok(rows[2].className.includes('lc-sl-row-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[2]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    await m.unmount()
  })

  test('a hostile no-wall timing keeps only the non-zero slices', async () => {
    const timing: TimingTotals = { wallMs: 0, ttftMs: 5_000, genMs: 0, calls: 3, toolsMs: 0, toolCalls: 1, tools: { bash: { calls: 1, ms: 0 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    // Only TTFT carries time; the zero slices are omitted whole (their dash
    // has nothing to qualify, and their borrowed call count would mislead).
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 1)
    assert.deepEqual(rowOf(m.container, 0), { pct: '—', label: 'TTFT', count: '5.0s · 3 calls', dim: false })
    await m.unmount()
  })

  test('a slice that never happened is omitted, not rendered as a zero row', async () => {
    // The screenshot case: no reasoning output, no tool calls — the rows that
    // would borrow the session's call count ("0.0% · 3 calls") are dropped.
    const timing: TimingTotals = {
      wallMs: 532, ttftMs: 480, genMs: 52, reasoningMs: 0, textMs: 52, toolArgMs: 0,
      calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
    }
    const m = await mount(h(StatsTiming, { timing }))
    const labels = queryAll(m.container, '.lc-sl-label').map(n => n.textContent)
    assert.deepEqual(labels, ['TTFT', 'Answers'], 'zero buckets and zero tools are gone')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, queryAll(m.container, '.lc-donut-seg').length)
    await m.unmount()
  })

  test('every slice zero with a live call count still renders the empty state', async () => {
    // calls > 0 opens the card, but nothing was priced: no rows survive.
    const timing: TimingTotals = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} }
    const m = await mount(h(StatsTiming, { timing }))
    assert.ok(text(m.container).includes('No timing data yet'))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
    await m.unmount()
  })
})

describe('StatsTiming — the generation split', () => {
  // genMs 140s splits into thinking 90s, answer 30s, tool args 20s.
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }

  test('the model slice expands into thinking / answer / tool args', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 6)
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '15.0%', label: 'Thinking', count: '1m30s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 4), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 5), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    // Six ring segments: the three decode buckets replace the single gen arc.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 6)
    await m.unmount()
  })

  test('the decode slices carry NO call count — they count blocks, not calls', async () => {
    // One model call can emit several tool-call blocks and often emits no
    // reasoning at all, so a borrowed per-call count would be a false tally.
    const timing: TimingTotals = { ...SPLIT, calls: 236, toolCalls: 302 }
    const m = await mount(h(StatsTiming, { timing }))
    const sub = (i: number): string => queryAll(m.container, '.lc-sl-sub')[i]?.textContent ?? ''
    assert.equal(sub(0), '1m40s · 236 calls', 'TTFT keeps its per-call count')
    for (const i of [1, 2, 3]) {
      assert.ok(!sub(i).includes('236 calls'), `decode row ${i} must not borrow the call count: ${sub(i)}`)
      assert.ok(!sub(i).includes('302'), `decode row ${i} must not borrow the tool count: ${sub(i)}`)
    }
    assert.equal(sub(4), '5m0s · 302 runs', 'tools keep their own per-run count')
    await m.unmount()
  })

  test('the decode rows qualify with their OWN block tallies when the host folded them', async () => {
    const timing: TimingTotals = { ...SPLIT, reasoningBlocks: 14, textBlocks: 5, toolArgBlocks: 26 }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 1), { pct: '15.0%', label: 'Thinking', count: '1m30s · 14 blocks', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s · 5 blocks', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s · 26 blocks', dim: false })
    await m.unmount()
  })

  test('a zero or absent block tally renders the duration alone; the count localizes', async () => {
    const zh = await mount(h(StatsTimingZh, { timing: { ...SPLIT, reasoningBlocks: 3 } }))
    assert.equal(rowOf(zh.container, 1).count, '1m30s · 3次')
    await zh.unmount()
    for (const counts of [{ reasoningBlocks: 0 }, {}]) {
      const m = await mount(h(StatsTiming, { timing: { ...SPLIT, ...counts } }))
      assert.equal(rowOf(m.container, 1).count, '1m30s', JSON.stringify(counts))
      await m.unmount()
    }
  })

  test('the split labels localize', async () => {
    const m = await mount(h(StatsTimingZh, { timing: SPLIT }))
    assert.equal(rowOf(m.container, 1).label, '模型思考')
    assert.equal(rowOf(m.container, 2).label, '模型回复')
    assert.equal(rowOf(m.container, 3).label, '工具参数')
    await m.unmount()
  })

  test('an absent split keeps the single LLM Gen row', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.equal(rowOf(m.container, 1).label, 'LLM Gen')
    await m.unmount()
  })

  test('all-zero buckets keep the un-split shape instead of three dead rows', async () => {
    const m = await mount(h(StatsTiming, { timing: { ...TIMING, reasoningMs: 0, textMs: 0, toolArgMs: 0 } }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.equal(rowOf(m.container, 1).label, 'LLM Gen')
    await m.unmount()
  })

  test('a hostile bucket total exceeding the generation window clamps the ring, rows stay true', async () => {
    // The buckets claim 500s inside a 140s generation window: the ring caps
    // them to the window while every row keeps its own figure.
    const timing: TimingTotals = { ...SPLIT, reasoningMs: 400_000, textMs: 100_000, toolArgMs: 0 }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 1), { pct: '66.7%', label: 'Thinking', count: '6m40s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '16.7%', label: 'Answers', count: '1m40s', dim: false })
    // The zero tool-args bucket is omitted whole, so Tools follows Answers.
    assert.equal(rowOf(m.container, 3).label, 'Tool runs')
    await m.unmount()
  })
})

describe('StatsTiming — the throughput figure', () => {
  const paired: TimingTotals = { ...TIMING, speedTokens: 12_345, speedMs: 42_720 }

  test('the paired seat renders the output-speed figure in the title row', async () => {
    const m = await mount(h(StatsTiming, { timing: paired }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'TPS 289 tok/s', '12345 tokens over 42.72s')
    assert.ok(rate?.getAttribute('title')?.includes('Output speed (TPS)'))
    await m.unmount()
  })

  test('the figure localizes its label and tooltip in the title row', async () => {
    const m = await mount(h(StatsTimingZh, { timing: paired }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, '输出速度 289 tok/s')
    assert.ok(rate?.getAttribute('title')?.includes('输出速度（TPS）'))
    await m.unmount()
  })

  test('a sub-10 figure keeps one decimal', async () => {
    const m = await mount(h(StatsTiming, { timing: { ...TIMING, speedTokens: 26, speedMs: 10_000 } }))
    assert.equal(query(m.container, '.lc-card-rate')?.textContent, 'TPS 2.6 tok/s')
    await m.unmount()
  })

  test('an unpaired, zero-window, or hostile seat renders no figure', async () => {
    for (const timing of [
      TIMING,
      { ...TIMING, speedTokens: 500, speedMs: 0 },
      { ...TIMING, speedTokens: Number.NaN, speedMs: 1_000 },
      { ...TIMING, speedTokens: -5, speedMs: 1_000 },
    ] as TimingTotals[]) {
      const m = await mount(h(StatsTiming, { timing }))
      assert.equal(queryAll(m.container, '.lc-card-rate').length, 0, JSON.stringify(timing.speedTokens))
      await m.unmount()
    }
  })
})

describe('StatsTiming — the session-time strip', () => {
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }
  // A 50-second session window (epoch 1s → 51s) holding 40s of ACTIVE time:
  // the decode slices, then tools and overhead — with 5s idle gaps between
  // them (21s → 26s and 41s → 46s) that take no track on the strip.
  const SPANS: TimingSpan[] = [
    { kind: 'ttft', start: 1_000, end: 6_000 },
    { kind: 'reasoning', start: 6_000, end: 16_000 },
    { kind: 'text', start: 16_000, end: 21_000 },
    { kind: 'tools', start: 26_000, end: 41_000 },
    { kind: 'other', start: 46_000, end: 51_000 },
  ]

  test('the strip packs the folded spans by their share of the active time over the zero/quartile/full axis', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING, spans: SPANS }))
    const segs = queryAll(m.container, '.lc-tstrip-seg')
    assert.equal(segs.length, 5)
    assert.deepEqual(segs.map(s => parseFloat((s as HTMLElement).style.left)), [0, 12.5, 37.5, 50, 87.5])
    assert.deepEqual(segs.map(s => parseFloat((s as HTMLElement).style.width)), [12.5, 25, 12.5, 37.5, 12.5])
    const ticks = queryAll(m.container, '.lc-tstrip-tick')
    assert.deepEqual(ticks.map(t => t.textContent), ['0', '10.0s', '20.0s', '30.0s', '40.0s'])
    await m.unmount()
  })

  test('an absent or empty spans collection paints no strip (the aggregate overview card)', async () => {
    const collections: (TimingSpan[] | undefined)[] = [undefined, []]
    for (const spans of collections) {
      const m = await mount(h(StatsTiming, { timing: TIMING, spans }))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 4, 'the rows still render')
      assert.equal(queryAll(m.container, '.lc-tstrip').length, 0)
      await m.unmount()
    }
  })

  test('the empty timing state shows no strip even with spans', async () => {
    const m = await mount(h(StatsTiming, { timing: null, spans: SPANS }))
    assert.ok(text(m.container).includes('No timing data yet'))
    assert.equal(queryAll(m.container, '.lc-tstrip').length, 0)
    await m.unmount()
  })

  test('a strip band hover lights its donut arc and legend row by KIND — the shared hover link', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const segs = queryAll(m.container, '.lc-tstrip-seg')
    await hover(segs[3])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, `Tool runs 15.0s · ${timeOf(26_000)}`)
    assert.ok(segs[3].className.includes('lc-tstrip-seg-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[4]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(queryAll(m.container, '.lc-sl-row')[4].className.includes('lc-sl-row-on'))
    await m.unmount()
  })

  test('a legend row hover lights the strip spans of that kind WITHOUT floating the strip tip (the mirror rule)', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(m.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'))
    const on = queryAll(m.container, '.lc-tstrip-seg-on')
    assert.equal(on.length, 1)
    assert.equal(on[0], queryAll(m.container, '.lc-tstrip-seg')[1])
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('the strip tip localizes', async () => {
    const m = await mount(h(StatsTimingZh, { timing: SPLIT, spans: SPANS }))
    await hover(queryAll(m.container, '.lc-tstrip-seg')[1])
    assert.equal(query(m.container, '.lc-bar-tip').textContent, `模型思考 10.0s · ${timeOf(6_000)}`)
    await m.unmount()
  })
})
