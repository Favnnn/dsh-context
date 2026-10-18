import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { aggregateByTurn, attachMarkers, jumpTargetOf, turnStepsOf } from '../../../src/client/components/trendChart'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { click, mount, query, queryAll } from '../helpers/kit'
import { TrendChart, bars, propsOf, req } from './trendChartHarness'

describe('aggregateByTurn', () => {
  test('collapses a run of same-turn steps into its last record tagged with the step count', () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1, total: 500 }),
      req(3, { turn: 2, step: 0 }),
    ])
    assert.equal(agg.length, 2)
    assert.equal(agg[0].seq, 2, 'the turn bar is its LAST step')
    assert.equal(agg[0].stepCount, 2)
    assert.equal(agg[0].total, 500)
    assert.equal(agg[1].stepCount, 1)
  })

  test('turnless requests share turn 0; a turnless run breaks at the first stamped turn', () => {
    const agg = aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: undefined })])
    assert.equal(agg.length, 1)
    assert.equal(agg[0].stepCount, 2)
    const mixed = aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: 1 })])
    assert.equal(mixed.length, 2)
  })

  test('an empty history aggregates to nothing', () => {
    assert.deepEqual(aggregateByTurn([]), [])
  })

  test('the duration overlay\'s ms sums across a turn\'s steps; absent only when no step carried one', () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, activeMs: 2500 }),
      req(3, { turn: 2, step: 0, activeMs: 800 }),
    ])
    assert.equal(agg[0].activeMs, 3500, 'the turn bar carries its steps\' summed active time')
    assert.equal(agg[1].activeMs, 800, 'a single-step turn keeps its own figure')

    // A step without a stamp contributes nothing but does not hide the run's known share.
    const partial = aggregateByTurn([req(1, { turn: 1, activeMs: 1000 }), req(2, { turn: 1 })])
    assert.equal(partial[0].activeMs, 1000)
    const none = aggregateByTurn([req(1, { turn: 1 }), req(2, { turn: 1 })])
    assert.ok(!('ms' in none[0]), 'no fabricated zero when no step reported')
  })
})

describe('turnStepsOf', () => {
  test('tallies per-turn step counts over the raw records; turnless pool under 0', () => {
    const stepsOf = turnStepsOf([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1 }),
      req(3, { turn: 2, step: 0 }),
      req(4, { turn: undefined, step: undefined }),
    ])
    assert.equal(stepsOf(1), 2)
    assert.equal(stepsOf(2), 1)
    assert.equal(stepsOf(undefined), 1, 'turnless records read the pooled 0 key')
  })

  test('a turn outside the list answers 1 instead of missing', () => {
    assert.equal(turnStepsOf([req(1, { turn: 1 })])(9), 1)
    assert.equal(turnStepsOf([])(1), 1)
  })
})

describe('jumpTargetOf', () => {
  test('matches the exact seq; an aged-out seq clamps to the oldest retained request', () => {
    const reqs = [req(50), req(60), req(70)]
    assert.equal(jumpTargetOf(reqs, 60)?.seq, 60)
    assert.equal(jumpTargetOf(reqs, 10)?.seq, 50, 'below the window → the oldest retained bar')
    assert.equal(jumpTargetOf([], 1), null)
  })
})

describe('TrendChart entrance rise', () => {
  const slot = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--lc-i')

  test('each bar carries its rise stagger slot, capped so a long log settles quickly', async () => {
    const reqs = Array.from({ length: 25 }, (_, i) => req(i + 1))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const stacks = queryAll(m.container, '.lc-bar-stack')
    assert.equal(stacks.length, 25)
    assert.equal(slot(stacks[0]), '0')
    assert.equal(slot(stacks[1]), '1')
    assert.equal(slot(stacks[19]), '19')
    assert.equal(slot(stacks[20]), '20')
    assert.equal(slot(stacks[24]), '20')
    await m.unmount()
  })

  test('delta arms share their bar rise stagger slot', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 50, user: 60 })
    const m = await mount(h(TrendChart, propsOf([r1, r2], { mode: 'delta' })))
    const ups = queryAll(m.container, '.lc-bar-up')
    const downs = queryAll(m.container, '.lc-bar-down')
    assert.equal(slot(ups[0]), '0')
    assert.equal(slot(ups[1]), '1')
    assert.equal(slot(downs[1]), '1')
    // The first bar diffs against nothing, so it grows no down arm.
    assert.equal(queryAll(downs[0], 'div').length, 0)
    await m.unmount()
  })

  test('switching granularity remounts every bar so the entrance rise replays', async () => {
    // A turn aggregate IS its last step's record (the same seq): without the granularity-keyed remount,
    // a turn → step switch would reuse that bar's DOM node and its turn-final step bars would not rise.
    function GranularityHarness(props: { requests: RequestRecord[] }) {
      const [granularity, setGranularity] = useState<'step' | 'turn'>('turn')
      // The parent (ContextView) aggregates for turn granularity; TrendChart renders what it is given.
      const display = granularity === 'turn' ? aggregateByTurn(props.requests) : props.requests
      return h('div', null,
        h('button', { onClick: () => { setGranularity('step') } }, 'to-step'),
        h(TrendChart, { ...propsOf(display), granularity }))
    }
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const m = await mount(h(GranularityHarness, { requests: reqs }))
    // Turn mode: one aggregate per turn, each keyed by its LAST step's seq.
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['2', '3'])
    const reusedSeq = query(m.container, '.lc-bar[data-seq="2"]')
    await click(query(m.container, 'button'))
    // Step mode renders every step; even the seq the aggregate reused must be a FRESH node.
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['1', '2', '3'])
    assert.notEqual(query(m.container, '.lc-bar[data-seq="2"]'), reusedSeq)
    await m.unmount()
  })
})

describe('attachMarkers', () => {
  test('attaches each boundary event to the first request logged after it', () => {
    const reqs = [req(5), req(10)]
    const ev: ContextEventRecord = { seq: 7, time: 0, kind: 'compaction' }
    const markers = attachMarkers(reqs, [ev])
    assert.equal(markers.length, 2)
    assert.equal(markers[0], undefined)
    assert.equal(markers[1], ev)
  })

  test('events after the whole log, and non-boundary kinds, attach nowhere', () => {
    const reqs = [req(5), req(10)]
    // `new Array(n)` leaves holes: an event that never matches assigns no index at all.
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 99, time: 0, kind: 'prune' }])).length, 0)
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 1, time: 0, kind: 'inject' }])).length, 0)
    assert.equal(attachMarkers([], [{ seq: 1, time: 0, kind: 'compaction' }]).length, 0)
  })

  test('the first event to claim a request index wins', () => {
    const reqs = [req(5), req(10)]
    const first: ContextEventRecord = { seq: 1, time: 0, kind: 'compaction' }
    const second: ContextEventRecord = { seq: 2, time: 0, kind: 'prune' }
    const markers = attachMarkers(reqs, [first, second])
    assert.equal(markers[0], first)
    assert.equal(markers[1], undefined)
  })
})
