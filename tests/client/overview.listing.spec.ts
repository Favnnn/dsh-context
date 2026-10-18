import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  dayRangeWindow,
  filterRows,
  OPEN_WINDOW,
  orderedDayRange,
  pageOf,
  rangeWindowOf,
  relativeTime,
  sortRows,
} from '../../src/client/overview'
import type { ContextTimeline } from '../../src/shared/types'
import { COST, rowOf, win } from './overview.fixtures'

describe('rangeWindowOf', () => {
  test('each preset pins its start; all is the open window', () => {
    // Local anchors, so the calendar-day window reads the same in every zone.
    const now = new Date(2026, 8, 20, 12).getTime()
    const midnight = new Date(2026, 8, 20).getTime()
    assert.deepEqual(rangeWindowOf('today', now), { start: midnight, end: null }, 'today opens on the local midnight')
    assert.deepEqual(rangeWindowOf('7d', now), { start: now - 7 * 86_400_000, end: null })
    assert.deepEqual(rangeWindowOf('30d', now), { start: now - 30 * 86_400_000, end: null })
    assert.deepEqual(rangeWindowOf('all', now), OPEN_WINDOW, 'no bound at either end')
    assert.deepEqual(OPEN_WINDOW, { start: null, end: null })
  })
})

describe('dayRangeWindow', () => {
  test('a picked range spans both of its days whole', () => {
    assert.deepEqual(dayRangeWindow({ from: '2026-09-10', to: '2026-09-12' }), {
      start: new Date(2026, 8, 10).getTime(),
      end: new Date(2026, 8, 12, 23, 59, 59, 999).getTime(),
    }, 'start at the first midnight, end at the last millisecond')
    assert.deepEqual(dayRangeWindow({ from: '2026-09-10', to: '2026-09-10' }), {
      start: new Date(2026, 8, 10).getTime(),
      end: new Date(2026, 8, 10, 23, 59, 59, 999).getTime(),
    }, 'a one-day range counts that whole day')
  })

  test('a malformed key on either end yields no window at all', () => {
    assert.equal(dayRangeWindow({ from: 'garbage', to: '2026-09-12' }), null)
    assert.equal(dayRangeWindow({ from: '2026-09-10', to: '2026-02-30' }), null)
  })

  test('a pair that arrives backwards is ordered on the way in', () => {
    // The pick path sorts already; this is the seam that keeps a hand-built
    // pair from filtering the page down to an empty window.
    assert.deepEqual(dayRangeWindow({ from: '2026-09-12', to: '2026-09-10' }), dayRangeWindow({ from: '2026-09-10', to: '2026-09-12' }))
  })
})

describe('orderedDayRange', () => {
  test('a backwards pair swaps its ends rather than inverting', () => {
    assert.deepEqual(orderedDayRange('2026-09-10', '2026-09-12'), { from: '2026-09-10', to: '2026-09-12' })
    assert.deepEqual(orderedDayRange('2026-09-12', '2026-09-10'), { from: '2026-09-10', to: '2026-09-12' })
    assert.deepEqual(orderedDayRange('2026-09-10', '2026-09-10'), { from: '2026-09-10', to: '2026-09-10' })
  })
})

describe('filterRows', () => {
  const midnight = new Date(2026, 8, 11).getTime()
  const now = midnight + 12 * 3_600_000
  const rows = [
    rowOf({ id: 'old', title: 'ancient logs', updatedAt: midnight - 20 * 86_400_000 }),
    rowOf({ id: 'new', title: 'fresh fix', cwd: '/repo/app', updatedAt: now - 2 * 3_600_000 }),
    rowOf({
      id: 'active',
      title: 'busy bee',
      updatedAt: now - 2 * 3_600_000,
      activity: { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 0, requests: 0 } } },
    }),
  ]

  test('the range window filters by last activity', () => {
    assert.deepEqual(filterRows(rows, { scope: win('today', now), day: null, query: '' }).map(r => r.id), ['new', 'active'])
    assert.deepEqual(filterRows(rows, { scope: win('7d', now), day: null, query: '' }).map(r => r.id), ['new', 'active'])
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: null, query: '' }).map(r => r.id), ['old', 'new', 'active'])
    // Today's own boundary: hours in, one minute before the local midnight out.
    const dRows = [
      rowOf({ id: 'in', title: 'this morning', updatedAt: now - 2 * 3_600_000 }),
      rowOf({ id: 'out', title: 'last night', updatedAt: midnight - 60_000 }),
    ]
    assert.deepEqual(filterRows(dRows, { scope: win('today', now), day: null, query: '' }).map(r => r.id), ['in'])
    assert.deepEqual(filterRows(dRows, { scope: win('7d', now), day: null, query: '' }).map(r => r.id), ['in', 'out'], 'last night is still inside the week')
  })

  test('a picked range closes both ends of the window', () => {
    // A two-day window: the day before its start and the day after its end are
    // both out, and the end day's last millisecond is still in.
    const scope = dayRangeWindow({ from: '2026-09-10', to: '2026-09-11' })
    assert.ok(scope !== null)
    const window = [
      rowOf({ id: 'before', updatedAt: new Date(2026, 8, 9, 23, 59).getTime() }),
      rowOf({ id: 'first', updatedAt: new Date(2026, 8, 10).getTime() }),
      rowOf({ id: 'last', updatedAt: new Date(2026, 8, 11, 23, 59, 59, 999).getTime() }),
      rowOf({ id: 'after', updatedAt: new Date(2026, 8, 12).getTime() }),
    ]
    assert.deepEqual(filterRows(window, { scope, day: null, query: '' }).map(r => r.id), ['first', 'last'])
  })

  test('the day pin keeps only sessions contributing to that day', () => {
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: '2026-09-16', query: '' }).map(r => r.id), ['active'])
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: '2026-09-10', query: '' }), [], 'a zero day is no contribution')
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: '2026-09-11', query: '' }), [], 'no ledger entry')
  })

  test('the query matches title, directory, or last message, case-insensitively', () => {
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: null, query: 'FRESH' }).map(r => r.id), ['new'])
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: null, query: '/repo' }).map(r => r.id), ['new'])
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: null, query: '  ' }).length, 3, 'a blank query matches all')
    assert.deepEqual(filterRows(rows, { scope: win('all', now), day: null, query: 'zzz' }), [])
    // The session's newest own message joins the haystack.
    const talked = rowOf({ id: 'talk', title: 'quiet title', timeline: { lastUser: 'ship the QUARTERLY report' } as unknown as ContextTimeline })
    assert.deepEqual(filterRows([talked], { scope: win('all', now), day: null, query: 'quarterly' }).map(r => r.id), ['talk'])
    assert.deepEqual(filterRows([talked], { scope: win('all', now), day: null, query: 'quiet' }).map(r => r.id), ['talk'], 'the title still matches')
    // A non-string last message (a hostile fold shape) never matches.
    const odd = rowOf({ id: 'odd', title: 'odd one', timeline: { lastUser: 42 } as unknown as ContextTimeline })
    assert.deepEqual(filterRows([odd], { scope: win('all', now), day: null, query: '42' }), [])
  })
})

describe('sortRows', () => {
  const cheap = rowOf({ id: 'cheap', updatedAt: 1, timeline: { current: { total: 50 }, cost: COST } as unknown as ContextTimeline, familyCost: COST })
  const dear = rowOf({
    id: 'dear',
    updatedAt: 2,
    timeline: {
      current: { total: 900 },
      cost: { deepseek: { m: { peak: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    } as unknown as ContextTimeline,
    familyCost: { deepseek: { m: { peak: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
  })
  const plain = rowOf({ id: 'plain', updatedAt: 3 })

  test('recent orders by last activity, tokens by billed volume, context by current size', () => {
    const input = [cheap, plain, dear]
    assert.deepEqual(sortRows(input, 'recent').map(r => r.id), ['plain', 'dear', 'cheap'])
    assert.deepEqual(sortRows(input, 'tokens').map(r => r.id), ['dear', 'cheap', 'plain'], 'a data-less row sinks')
    assert.deepEqual(sortRows(input, 'context').map(r => r.id), ['dear', 'cheap', 'plain'])
    assert.deepEqual(input.map(r => r.id), ['cheap', 'plain', 'dear'], 'the input is never mutated')
  })
})

describe('pageOf', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `s${i}`)

  test('a short list renders as one page holding everything', () => {
    assert.deepEqual(pageOf(['a', 'b'], 0), { items: ['a', 'b'], index: 0, count: 1 })
    assert.deepEqual(pageOf([], 0), { items: [], index: 0, count: 1 }, 'an empty list still renders one page')
  })

  test('pages slice the rows at the fixed size', () => {
    const first = pageOf(rows, 0)
    assert.equal(first.count, 5)
    assert.equal(first.items.length, 12)
    assert.deepEqual(pageOf(rows, 4), { items: rows.slice(48), index: 4, count: 5 }, 'the tail page holds the rest')
  })

  test('an out-of-range request clamps into the live range', () => {
    assert.equal(pageOf(rows, -1).index, 0, 'a negative request lands on the first page')
    assert.equal(pageOf(rows, 9).index, 4, 'a page that a shrink left out of range lands on the last')
  })
})

describe('relativeTime', () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params === undefined ? key : `${key}:${String(params.n)}`
  const now = 10 * 86_400_000

  test('steps through just-now, minutes, hours, days', () => {
    assert.equal(relativeTime(t, now, now), 'ov.time.now')
    assert.equal(relativeTime(t, now - 59_000, now), 'ov.time.now')
    assert.equal(relativeTime(t, now - 5 * 60_000, now), 'ov.time.m:5')
    assert.equal(relativeTime(t, now - 59 * 60_000, now), 'ov.time.m:59')
    assert.equal(relativeTime(t, now - 3 * 3_600_000, now), 'ov.time.h:3')
    assert.equal(relativeTime(t, now - 23 * 3_600_000, now), 'ov.time.h:23')
    assert.equal(relativeTime(t, now - 9 * 86_400_000, now), 'ov.time.d:9')
  })

  test('future and invalid stamps read as just-now (clock skew is not an error)', () => {
    assert.equal(relativeTime(t, now + 60_000, now), 'ov.time.now')
    assert.equal(relativeTime(t, Number.NaN, now), 'ov.time.now')
  })
})
