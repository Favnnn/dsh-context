import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { gridOf, makeHeatmap, todayKey } from '../../../src/client/components/heatmap'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Heatmap = makeHeatmap(kit)

// 2026-09-16 was a Wednesday of the week starting Sunday 2026-09-13.
const TODAY = '2026-09-16'

describe('gridOf', () => {
  test('lays out weeks of Sunday-first columns ending at today’s week', () => {
    const grid = gridOf(TODAY, 2)
    assert.ok(grid !== null)
    assert.equal(grid.length, 2)
    assert.equal(grid[0][0].key, '2026-09-06', 'the first column opens one week earlier')
    assert.equal(grid[1][0].key, '2026-09-13', 'the last column is today’s Sunday')
    assert.equal(grid[1][3].key, TODAY)
    assert.equal(grid[1][3].future, false)
    assert.equal(grid[1][4].future, true, 'days after today render as future placeholders')
    assert.equal(grid[1][6].key, '2026-09-19')
  })

  test('degraded inputs read null (the card then shows its empty note)', () => {
    assert.equal(gridOf('', 2), null)
    assert.equal(gridOf('garbage', 2), null)
    assert.equal(gridOf(TODAY, 0), null, 'no columns to draw')
    assert.equal(gridOf(TODAY, 3000), null, 'a window reaching before the epoch has no first Sunday')
    // 9999-12-31 was a Friday of the week starting Sunday 9999-12-26: the
    // week's tail days leave the four-digit year, so no grid can hold it.
    assert.equal(gridOf('9999-12-31', 2), null, 'the final week of the representable range overflows')
  })
})

describe('Heatmap', () => {
  test('an empty ledger renders the empty note, no grid', async () => {
    const m = await mount(h(Heatmap, { days: {}, today: TODAY }))
    assert.ok(text(m.container).includes('No activity yet'))
    assert.equal(queryAll(m.container, '.lc-heat-cell').length, 0)
    await m.unmount()
  })

  test('a corrupt today key degrades to the empty note', async () => {
    const m = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 5, requests: 1, sessions: 1, cost: null } }, today: 'junk' }))
    assert.ok(text(m.container).includes('No activity yet'))
    await m.unmount()
  })

  test('cells draw with depth levels; data days are buttons with labels', async () => {
    const days = {
      '2026-09-16': { tokens: 100, requests: 4, sessions: 2, cost: null },
      '2026-09-15': { tokens: 50, requests: 2, sessions: 1, cost: null },
      '2026-09-14': { tokens: 25, requests: 1, sessions: 1, cost: null },
      '2026-09-10': { tokens: 30, requests: 0, sessions: 1, cost: null },
      '2026-09-09': { tokens: 75, requests: 3, sessions: 3, cost: null },
      '2026-09-08': { tokens: 1, requests: 1, sessions: 1, cost: null },
      '2026-09-07': { tokens: 0, requests: 2, sessions: 1, cost: null },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    const buttons = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    assert.equal(buttons.length, 7)
    const byKey = new Map(buttons.map(b => [b.getAttribute('aria-label')?.split('\n')[0], b]))
    assert.ok(byKey.get('2026-09-16')?.className.includes('lc-heat-4'), 'the maximum day is deepest')
    assert.ok(byKey.get('2026-09-15')?.className.includes('lc-heat-2'))
    assert.ok(byKey.get('2026-09-14')?.className.includes('lc-heat-1'))
    assert.ok(byKey.get('2026-09-10')?.className.includes('lc-heat-0'), 'a day billed without a settled step stays gray')
    assert.ok(byKey.get('2026-09-09')?.className.includes('lc-heat-3'))
    assert.ok(byKey.get('2026-09-08')?.className.includes('lc-heat-1'), 'a crumb is never invisible')
    // The zero-token day counts as activity (requests > 0); depths ride the
    // steps metric, so its pair of steps draws half the peak.
    assert.ok(byKey.get('2026-09-07')?.className.includes('lc-heat-2'))
    assert.equal(byKey.get('2026-09-16')?.getAttribute('aria-label'), '2026-09-16\n2 active sessions\n4 steps')
    assert.equal(byKey.get('2026-09-10')?.getAttribute('aria-label'), '2026-09-10\n1 active sessions\n0 steps')
    // Inert cells: data-less days and future days draw as plain spans.
    const spans = queryAll(m.container, 'span.lc-heat-cell')
    assert.ok(spans.length > 0)
    assert.ok(spans.some(s => s.className.includes('lc-heat-future')), 'future placeholders present')
    // Weekday labels sit on the rows they name (Sunday-first: row 1 = Mon): Mon/Wed/Fri carry their names, the rest blank.
    const wds = queryAll(m.container, '.lc-heat-wd')
    assert.deepEqual(wds.map(w => w.textContent), ['', 'Mon', '', 'Wed', '', 'Fri', ''])
    await m.unmount()
  })

  test('month labels mark the columns where a month begins', async () => {
    const days = { '2026-09-16': { tokens: 10, requests: 1, sessions: 1, cost: null } }
    // The default 8-week window runs Sunday 2026-07-26 → 2026-09-13: July
    // began outside it, August begins in the Jul 26 column (Sat Aug 1) and September in the Aug 30 column (Tue Sep 1).
    const m = await mount(h(Heatmap, { days, today: TODAY }))
    assert.deepEqual(queryAll(m.container, '.lc-heat-mon').map(s => s.textContent), ['Aug', 'Sep'])
    await m.unmount()
    // A mid-month window never crosses a month's first day, yet the opening
    // column still names its own month; later columns stay unlabeled.
    const m2 = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    assert.deepEqual(queryAll(m2.container, '.lc-heat-mon').map(s => s.textContent), ['Sep'])
    await m2.unmount()
    // A later column that opens on the 1st carries the label itself (its
    // whole week stays in the new month; 2026-02-01 was a Sunday).
    const m3 = await mount(h(Heatmap, { days: { '2026-02-03': { tokens: 1, requests: 1, sessions: 1, cost: null } }, today: '2026-02-03', weeks: 2 }))
    assert.deepEqual(queryAll(m3.container, '.lc-heat-mon').map(s => s.textContent), ['Jan', 'Feb'])
    await m3.unmount()
  })

  test('a Less→More key lays out the five depth steps under the grid', async () => {
    const m = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1, cost: null } }, today: TODAY, weeks: 2 }))
    const legend = query(m.container, '.lc-heat-legend')
    assert.deepEqual(queryAll(legend, '.lc-heat-cell').map(s => s.className), [
      'lc-heat-cell lc-heat-0',
      'lc-heat-cell lc-heat-1',
      'lc-heat-cell lc-heat-2',
      'lc-heat-cell lc-heat-3',
      'lc-heat-cell lc-heat-4',
    ])
    assert.deepEqual(queryAll(legend, '.lc-heat-key').map(s => s.textContent), ['Less', 'More'])
    await m.unmount()
  })

  test('the sessions metric depths on each day’s distinct sessions, independently of steps', async () => {
    const days = {
      '2026-09-16': { tokens: 100, requests: 4, sessions: 2, cost: null },
      '2026-09-09': { tokens: 75, requests: 1, sessions: 3, cost: null },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2, metric: 'sessions' }))
    const byKey = new Map(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').map(b => [b.getAttribute('aria-label')?.split('\n')[0], b]))
    assert.ok(byKey.get('2026-09-16')?.className.includes('lc-heat-3'), 'two of the three-session peak draws level 3')
    assert.ok(byKey.get('2026-09-09')?.className.includes('lc-heat-4'), 'the sessions peak depths level 4 that its thin steps never would')
    await m.unmount()
  })

  test('cells carry the page hover tip in data attributes (date, sessions, steps; an empty day the bare date)', async () => {
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 3, cost: null } },
      today: TODAY,
      weeks: 2,
    }))
    assert.equal(
      query<HTMLButtonElement>(m.container, 'button.lc-heat-cell').getAttribute('data-lc-tip'),
      '2026-09-16\n3 active sessions\n1 steps',
    )
    assert.match(query(m.container, 'span.lc-heat-0').getAttribute('data-lc-tip') ?? '', /^\d{4}-\d{2}-\d{2}$/)
    await m.unmount()
  })

  test('clicking a data day pins it; clicking again releases; the ring follows the selection', async () => {
    const picked: (string | null)[] = []
    const record = (day: string | null): void => { picked.push(day) }
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1, cost: null } },
      today: TODAY,
      weeks: 2,
      selected: null,
      onSelect: record,
    }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await click(cell)
    assert.deepEqual(picked, ['2026-09-16'])
    await m.update(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1, cost: null } },
      today: TODAY,
      weeks: 2,
      selected: '2026-09-16',
      onSelect: record,
    }))
    assert.ok(query(m.container, 'button.lc-heat-cell').className.includes('lc-heat-on'))
    assert.equal(query(m.container, 'button.lc-heat-cell').getAttribute('aria-pressed'), 'true')
    await click(query<HTMLButtonElement>(m.container, 'button.lc-heat-cell'))
    assert.deepEqual(picked, ['2026-09-16', null], 'the second click releases the pin')
    await m.unmount()
  })

  test('without an onSelect relay the cells stay inert', async () => {
    const m = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 10, requests: 1, sessions: 1, cost: null } }, today: TODAY, weeks: 2 }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await click(cell)
    assert.ok(!cell.className.includes('lc-heat-on'))
    await m.unmount()
  })

  test('todayKey keys the render day (the panel’s runtime call)', () => {
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
  })
})
