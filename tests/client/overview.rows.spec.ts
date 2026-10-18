import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { billedOf, coveredRowsOf, rowsOfSnapshot, sessionsSnapshotOf, tokenPartsOf } from '../../src/client/overview'
import { mergeCostUsage } from '../../src/client/cost'
import type { SessionCostUsage } from '../../src/shared/types'
import { COST } from './overview.fixtures'

/** The minimal wire-valid timeline head, overridable per case. */
function timelineOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 10, tools: 20, user: 30, inject: 5, skill: 5, assistant: 40, tool: 50, total: 160 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

/** A session-list snapshot over rows of `{ id, row }` pairs. */
function snapshotOf(entries: [string, Record<string, unknown>][], current?: string): Record<string, unknown> {
  return {
    ids: entries.map(([id]) => id),
    byId: Object.fromEntries(entries),
    current,
    phase: 'ready',
  }
}

describe('sessionsSnapshotOf', () => {
  test('a non-function seat reads null', () => {
    assert.equal(sessionsSnapshotOf({}), null)
    assert.equal(sessionsSnapshotOf({ useSessions: 7 }), null)
  })

  test('a throwing seat reads null instead of taking the render down', () => {
    assert.equal(sessionsSnapshotOf({ useSessions: () => { throw new Error('boom') } }), null)
  })

  test('the raw snapshot passes through', () => {
    const snap = { ids: [] }
    assert.equal(sessionsSnapshotOf({ useSessions: (sel: (s: unknown) => unknown) => sel(snap) }), snap)
  })
})

describe('rowsOfSnapshot', () => {
  test('unusable snapshots read null (the unavailable note, not an empty list)', () => {
    assert.equal(rowsOfSnapshot(null), null)
    assert.equal(rowsOfSnapshot(7), null)
    assert.equal(rowsOfSnapshot({}), null, 'ids missing')
    assert.equal(rowsOfSnapshot({ ids: 'x' }), null, 'ids not an array')
  })

  test('an empty ready list reads as a real empty array', () => {
    assert.deepEqual(rowsOfSnapshot({ ids: [], byId: {} }), [])
    assert.deepEqual(rowsOfSnapshot({ ids: ['s1'] }), [], 'byId absent: the row is skipped')
    assert.deepEqual(rowsOfSnapshot({ ids: [7, 's1'], byId: {} }), [], 'non-string ids drop')
  })

  test('blank rows drop; metadata derives on the display ladder', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['a', { blank: true, displayTitle: 'blank one' }],
      ['b', { displayTitle: 'shown', updatedAt: 5, running: true }],
      ['c', { title: 'titled' }],
      ['d', {}],
      ['e', { displayTitle: '', title: '', cwd: '/repo', updatedAt: 'x' }],
    ], 'b'))
    assert.ok(rows !== null)
    assert.equal(rows.length, 4)
    const [b, c, d, e] = rows
    assert.deepEqual(b, {
      id: 'b', title: 'shown', updatedAt: 5, running: true, current: true, archived: false,
      timeline: null, activity: null, family: [null], familyCost: null,
    })
    assert.equal(c.title, 'titled')
    assert.equal(c.current, false)
    assert.equal(d.title, 'd', 'the id is the last-resort title')
    assert.equal(e.title, 'e', 'empty strings fall through the ladder')
    assert.equal(e.cwd, '/repo')
    assert.equal(e.updatedAt, 0, 'a non-numeric stamp zeroes')
  })

  test('archived sessions are tagged, not dropped; a hostile archive set fails open', () => {
    const snap = snapshotOf([
      ['a', { displayTitle: 'live' }],
      ['b', { displayTitle: 'archived' }],
      ['c', { displayTitle: 'kept' }],
    ])
    const rows = rowsOfSnapshot(snap, { archivedSessionIds: ['b', 7, null] })
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c'])
    assert.equal(rows[1].archived, true, 'the archived id tags its row')
    assert.equal(rows[0].archived, false)
    assert.equal(rows[2].archived, false, 'non-string entries archive nothing')
    // Fail-open shapes: an absent seat, a bare record, a malformed set, and a throwing accessor all keep the full list.
    assert.equal(rowsOfSnapshot(snap)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, null)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, 7)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, {})?.length, 3)
    assert.equal(rowsOfSnapshot(snap, { archivedSessionIds: 'x' })?.length, 3)
    assert.equal(rowsOfSnapshot(snap, { get archivedSessionIds() { throw new Error('boom') } })?.length, 3)
  })

  test('projection values are sanitized per row; hostile payloads degrade to nulls', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['a', {
        displayTitle: 'good',
        projectionValues: {
          contextTimeline: timelineOf({ counts: { turns: 2, steps: 3, injects: 0, compactions: 0, prunes: 0 } }),
          contextActivity: { days: { '2026-09-16': { tokens: 15, requests: 1 } } },
        },
      }],
      ['b', { displayTitle: 'junk', projectionValues: { contextTimeline: 7, contextActivity: 'x' } }],
    ]))
    assert.ok(rows !== null)
    const [a, b] = rows
    assert.equal(a.timeline?.counts?.turns, 2)
    assert.equal(a.activity?.days['2026-09-16'].tokens, 15)
    assert.equal(b.timeline, null)
    assert.equal(b.activity, null)
  })

  test('a hostile row that throws on access drops whole; the list survives', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom') } })
    const rows = rowsOfSnapshot({ ids: ['x', 'y'], byId: { x: hostile, y: { displayTitle: 'fine' } } })
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'y')
  })
})

describe('rowsOfSnapshot: subagent rows', () => {
  test('subagent-origin rows drop out (the workspace browser’s own exclusion)', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['main', { displayTitle: 'main session' }],
      ['child', { displayTitle: 'subagent run', origin: 'subagent', parentId: 'main' }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['main'])
  })
})

describe('rowsOfSnapshot: the family fold', () => {
  const COST2: SessionCostUsage = { zhipuai: { m: { peak: { uncached: 300, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
  /** A minimal head carrying the given billed usage (and a user-only composition). */
  function billedHead(tokens: number, cost?: SessionCostUsage): Record<string, unknown> {
    return timelineOf({
      current: { system: 0, tools: 0, user: tokens, inject: 0, skill: 0, assistant: 0, tool: 0, total: tokens },
      ...(cost !== undefined ? { cost } : {}),
    })
  }

  test('every descendant level folds into the root row’s family — members, cost, and days merge', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', {
        displayTitle: 'root',
        projectionValues: {
          contextTimeline: billedHead(100, COST),
          contextActivity: { days: { '2026-09-16': { tokens: 5, requests: 1, cost: COST } } },
        },
      }],
      ['kid', {
        origin: 'subagent', parentId: 'root',
        projectionValues: {
          contextTimeline: billedHead(50, COST2),
          contextActivity: { days: { '2026-09-16': { tokens: 7, requests: 2, cost: COST2 } } },
        },
      }],
      ['grand', {
        origin: 'subagent', parentId: 'kid',
        projectionValues: {
          contextTimeline: billedHead(25),
          contextActivity: { days: { '2026-09-16': { tokens: 4, requests: 1 }, '2026-09-15': { tokens: 3, requests: 1 } } },
        },
      }],
      ['stranger', { displayTitle: 'unrelated' }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['root', 'stranger'], 'subagent-origin rows stay unlisted')
    const [root, stranger] = rows
    assert.equal(root.family.length, 3, 'self + kid + grand — all levels')
    // COST (200) + COST2 (300) merge; the grandchild carried no cost.
    assert.equal(billedOf(root), 500)
    assert.equal(billedOf(stranger), null)
    // The daily ledgers merge across the subtree, pricing records included.
    assert.equal(root.activity?.days['2026-09-16'].tokens, 16)
    assert.equal(root.activity?.days['2026-09-16'].requests, 4)
    assert.deepEqual(root.activity?.days['2026-09-16'].cost, mergeCostUsage(COST, COST2))
    assert.equal(root.activity?.days['2026-09-15'].tokens, 3)
    assert.equal(root.activity?.days['2026-09-15'].cost, undefined)
    // The composed split proportions each member's OWN composition: the root's
    // all-user 160 billed input + output 40, the kid's all-user 300 — user 460 / output 40.
    const parts = tokenPartsOf([root])
    assert.deepEqual(parts, {
      total: 500,
      parts: [
        { key: 'user', color: 'var(--color-green-500)', value: 460 },
        { key: 'output', color: 'var(--color-pink-500)', value: 40 },
      ],
    })
  })

  test('an unlisted subtree (a subagent whose root never lists) leaks nowhere', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', { displayTitle: 'root', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['ghost', { origin: 'subagent', parentId: 'missing', projectionValues: { contextTimeline: billedHead(999, COST2) } }],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(billedOf(rows[0]), 200, 'the ghost subtree folds into no row')
  })

  test('a blank placeholder’s subtree stays out, and a lineage cycle cannot loop the walk', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      // The reachable cycle: root points at p and p points back — the walk
      // must cut at the revisited id (root counts its family, never itself twice).
      ['root', { displayTitle: 'root', parentId: 'p', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['p', { origin: 'subagent', parentId: 'root', projectionValues: { contextTimeline: billedHead(2, COST2) } }],
      ['blank', { blank: true, parentId: 'root', projectionValues: { contextTimeline: billedHead(9, COST2) } }],
      ['under-blank', { origin: 'subagent', parentId: 'blank', projectionValues: { contextTimeline: billedHead(9, COST2) } }],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].family.length, 2, 'root + p once; the blank is no agent and its child never links through')
    assert.equal(billedOf(rows[0]), 500, 'COST + COST2 — the cycle’s revisit adds nothing twice')
  })

  test('the daily ledgers’ skill tables merge name by name (loads sum, last takes the max)', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', {
        displayTitle: 'root',
        projectionValues: {
          contextActivity: { days: { '2026-09-16': { tokens: 5, requests: 1, skills: { tdd: { n: 2, last: 100 }, solo: { n: 1, last: 90 } } } } },
        },
      }],
      ['kid', {
        origin: 'subagent', parentId: 'root',
        projectionValues: {
          contextActivity: { days: { '2026-09-16': { tokens: 7, requests: 2, skills: { tdd: { n: 3, last: 200 }, fresh: { n: 1, last: 300 } } } } },
        },
      }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows[0].activity?.days['2026-09-16'].skills, {
      tdd: { n: 5, last: 200 },
      solo: { n: 1, last: 90 },
      fresh: { n: 1, last: 300 },
    })
  })

  test('hostile descendant projections degrade to null members, never a throw', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', { displayTitle: 'root', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['kid', { origin: 'subagent', parentId: 'root', projectionValues: { contextTimeline: 7, contextActivity: 'x' } }],
      ['junk', 5 as unknown as Record<string, unknown>],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows[0].family.length, 2)
    assert.equal(rows[0].family[1], null, 'the hostile head sanitizes to null in place')
    assert.equal(rows[0].activity, null, 'no member carried a ledger → the family has none')
    assert.equal(billedOf(rows[0]), 200)
  })
})

describe('coveredRowsOf', () => {
  test('all passes the list through; the narrow scopes split on the archived tag', () => {
    const rows = [
      { id: 'a', archived: false },
      { id: 'b', archived: true },
      { id: 'c', archived: true },
    ] as unknown as Parameters<typeof coveredRowsOf>[0]
    assert.equal(coveredRowsOf(rows, 'all'), rows)
    assert.deepEqual(coveredRowsOf(rows, 'active').map(r => r.id), ['a'])
    assert.deepEqual(coveredRowsOf(rows, 'archived').map(r => r.id), ['b', 'c'])
    assert.equal(coveredRowsOf([], 'archived').length, 0)
    assert.deepEqual(coveredRowsOf([], 'all'), [])
  })
})
