import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  aggregateDays,
  billedOf,
  createdDayOf,
  kpisOf,
  timingSumOf,
  tokenPartsOf,
  turnsOf,
  usageTotalsOf,
  type OverviewRow,
} from '../../src/client/overview'
import { priceIndexOf } from '../../src/client/cost'
import type { ContextActivity, ContextTimeline, SessionCostUsage } from '../../src/shared/types'
import { COST, rowOf } from './overview.fixtures'

describe('billedOf / turnsOf', () => {
  test('billed sums the team’s merged cost buckets; absent cost reads null', () => {
    assert.equal(billedOf(rowOf()), null)
    assert.equal(billedOf(rowOf({ familyCost: COST })), 200)
  })

  test('turns prefer the precomputed count and fall back to the records', () => {
    assert.equal(turnsOf(null), 0)
    assert.equal(turnsOf({ requests: [{}, {}] } as never), 2)
    assert.equal(turnsOf({ counts: { turns: 7 }, requests: [{}] } as never), 7)
  })
})

describe('createdDayOf', () => {
  const activity = { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 1, requests: 1 } } }

  test('the earliest ledger day stands in for the creation date', () => {
    assert.equal(createdDayOf(activity as ContextActivity), '2026-09-10')
    assert.equal(
      createdDayOf({ days: { '2026-09-10': { tokens: 1, requests: 1 }, '2026-09-16': { tokens: 5, requests: 1 } } } as ContextActivity),
      '2026-09-10',
      'a later day never displaces the earliest',
    )
  })

  test('no ledger, no days record, or an empty one names no creation date', () => {
    assert.equal(createdDayOf(null), undefined)
    assert.equal(createdDayOf({} as ContextActivity), undefined)
    assert.equal(createdDayOf({ days: {} } as ContextActivity), undefined)
  })
})

describe('usageTotalsOf', () => {
  test('absent or empty usage reads null (the caller keeps its dash)', () => {
    assert.equal(usageTotalsOf(null), null)
    assert.equal(usageTotalsOf(undefined), null)
    assert.equal(usageTotalsOf({}), null)
    assert.equal(usageTotalsOf({ deepseek: {} }), null)
    assert.equal(usageTotalsOf({ deepseek: { m: {} } }), null)
  })

  test('buckets sum per bucket and in total', () => {
    const totals = usageTotalsOf({
      deepseek: { a: { peak: { uncached: 10, cacheRead: 5, cacheWrite: 2, output: 3 }, off: { uncached: 4, cacheRead: 1, cacheWrite: 1, output: 1 } } },
      other: { b: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
    assert.deepEqual(totals, { input: 15, cacheRead: 6, cacheWrite: 3, output: 6, total: 30 })
  })
})

describe('timingSumOf', () => {
  test('no timing anywhere reads null', () => {
    assert.equal(timingSumOf([]), null)
    assert.equal(timingSumOf([rowOf()]), null)
    assert.equal(timingSumOf([rowOf({ timeline: { requests: [] } as unknown as ContextTimeline })]), null)
  })

  test('sums the required fields and merges the per-tool tallies; the inputs stay untouched', () => {
    const a = { wallMs: 100, ttftMs: 10, genMs: 60, calls: 2, toolsMs: 30, toolCalls: 3, tools: { read: { calls: 2, ms: 20 } } }
    const b = { wallMs: 50, ttftMs: 5, genMs: 30, calls: 1, toolsMs: 10, toolCalls: 1, tools: { read: { calls: 1, ms: 5 }, write: { calls: 1, ms: 10 } } }
    const sum = timingSumOf([
      rowOf({ timeline: { timing: a } as unknown as ContextTimeline }),
      rowOf({ timeline: { timing: b } as unknown as ContextTimeline }),
    ])
    assert.deepEqual(sum, {
      wallMs: 150, ttftMs: 15, genMs: 90, calls: 3, toolsMs: 40, toolCalls: 4,
      tools: { read: { calls: 3, ms: 25 }, write: { calls: 1, ms: 10 } },
    })
    // The rows' own totals are never mutated, and a field no row carries
    // stays absent (the card's un-split / no-chip fallbacks key off absence).
    assert.deepEqual(a.tools.read, { calls: 2, ms: 20 })
    assert.equal('reasoningMs' in (sum as object), false)
    assert.equal('speedMs' in (sum as object), false)
  })

  test('the additive-optional fields sum their carriers only', () => {
    const split = {
      wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
      reasoningMs: 4, reasoningBlocks: 2, textMs: 5, textBlocks: 1, speedTokens: 100, speedMs: 2_000,
    }
    const preSplit = { wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {} }
    const rowsOf = (timings: unknown[]): OverviewRow[] =>
      timings.map(timing => rowOf({ timeline: { timing } as unknown as ContextTimeline }))
    // Carrier first: the pre-split row adds nothing to the decode split.
    const sum = timingSumOf(rowsOf([split, preSplit]))
    const reverse = timingSumOf(rowsOf([preSplit, split]))
    for (const merged of [sum, reverse]) {
      assert.equal(merged?.genMs, 20, 'the generation window sums every row')
      assert.equal(merged?.reasoningMs, 4)
      assert.equal(merged?.reasoningBlocks, 2)
      assert.equal(merged?.textMs, 5)
      assert.equal(merged?.textBlocks, 1)
      assert.equal(merged?.toolArgMs, undefined, 'no row carries a tool-arg split')
      assert.equal(merged?.speedTokens, 100)
      assert.equal(merged?.speedMs, 2_000)
    }
    // Two carriers of one field sum both.
    const both = timingSumOf(rowsOf([split, { ...split, reasoningMs: 6, speedTokens: 50 }]))
    assert.equal(both?.reasoningMs, 10)
    assert.equal(both?.speedTokens, 150)
  })
})

describe('tokenPartsOf', () => {
  // The standard composition: system 100, tools 50, and a 350-token message
  // surface (user 30, inject 10, skill 10, assistant 200, tool 100).
  const STANDARD_CURRENT = { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }
  const TINY_CURRENT = { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }

  test('nothing billed reads null', () => {
    assert.equal(tokenPartsOf([]), null)
    assert.equal(tokenPartsOf([rowOf()]), null)
    assert.equal(
      tokenPartsOf([rowOf({ timeline: { current: STANDARD_CURRENT, requests: [] } as unknown as ContextTimeline })]),
      null,
      'a composition without billed buckets contributes nothing',
    )
  })

  test('folds each session\'s billedParts estimate by category; totals stay billed-exact', () => {
    const rows = [
      rowOf({ timeline: { current: STANDARD_CURRENT, cost: COST, requests: [] } as unknown as ContextTimeline }),
      rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, requests: [] } as unknown as ContextTimeline }),
    ]
    const folded = tokenPartsOf(rows)
    // Session 1: input 160 proportioned by 100:50:350 → 32/16/10/3/3/64/32, output 40.
    // Session 2: input 10 lands on its only category; its zero output adds nothing.
    assert.deepEqual(folded, {
      total: 210,
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
        { key: 'user', color: 'var(--color-green-500)', value: 10 },
        { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
        { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
        { key: 'assistant', color: 'var(--color-blue-500)', value: 64 },
        { key: 'tool', color: 'var(--color-teal-500)', value: 32 },
        { key: 'output', color: 'var(--color-pink-500)', value: 40 },
      ],
    })
  })

  test('a non-finite composition estimate drops whole instead of poisoning the sums', () => {
    const hostile = rowOf({
      timeline: {
        current: { system: Number.NaN, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: Number.NaN },
        cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
        requests: [],
      } as unknown as ContextTimeline,
    })
    const plain = rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m2: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } } } as unknown as ContextTimeline })
    assert.deepEqual(tokenPartsOf([hostile]), { parts: [], total: 0 })
    assert.deepEqual(tokenPartsOf([hostile, plain]), {
      total: 10,
      parts: [{ key: 'system', color: 'var(--color-indigo-500)', value: 10 }],
    })
  })
})

describe('kpisOf', () => {
  const prices = { prices: { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }

  test('aggregates sessions, tokens, turns, cost, cache hit, tools, and time across the range', () => {
    const rows = [
      rowOf({
        timeline: {
          cost: COST,
          counts: { turns: 3 },
          current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
          requests: [],
          timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7, tools: {} },
        } as unknown as ContextTimeline,
        familyCost: COST,
      }),
      rowOf({
        timeline: {
          requests: [{}, {}],
          timing: { wallMs: 30_000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
        } as unknown as ContextTimeline,
      }),
    ]
    const kpi = kpisOf(rows, prices, 'usd')
    assert.equal(kpi.sessions, 2)
    assert.equal(kpi.tokens, 200)
    assert.equal(kpi.turns, 5)
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the DeepSeek peak bucket doubles: 2 × (50×0.1 + 100×1 + 10×1 + 40×2) per 1M')
    assert.equal(kpi.cacheHit, '31.25', '50 reads of 160 billed input, truncated')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 1, 'only the billed session feeds the cache-hit rate')
    assert.equal(kpi.toolCalls, 7, 'tool calls sum across rows')
    assert.equal(kpi.toolsMs, 20_000)
    assert.equal(kpi.calls, 6)
    assert.equal(kpi.wallMs, 120_000)
    // The aggregate cards' sources: the composition-folded billed split (the
    // unbilled session adds nothing) and the summed timing totals.
    assert.equal(kpi.tokenParts?.total, 200)
    assert.deepEqual(kpi.tokenParts?.parts.find(p => p.key === 'system'), { key: 'system', color: 'var(--color-indigo-500)', value: 32 })
    assert.deepEqual(kpi.timing, { wallMs: 120_000, ttftMs: 1_000, genMs: 30_000, calls: 6, toolsMs: 20_000, toolCalls: 7, tools: {} })
  })

  test('a session with usage the book cannot price feeds the cache-hit rate but prices to nothing', () => {
    const rows = [
      rowOf({ timeline: { cost: COST, current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }, requests: [] } as unknown as ContextTimeline, familyCost: COST }),
      rowOf({
        timeline: {
          cost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 1, output: 2 } } } },
          current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
          requests: [],
        } as unknown as ContextTimeline,
        familyCost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 1, output: 2 } } } },
      }),
      rowOf(),
    ]
    const kpi = kpisOf(rows, prices, 'usd')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 2, 'both billed sessions feed the cache-hit rate')
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the unpriced session adds nothing to the estimate')
    assert.equal(kpi.tokenParts?.total, 218, 'both sessions\' billed totals fold into the split')
    assert.equal(kpi.timing, null)
  })

  test('an unbilled set zeroes and dashes', () => {
    const kpi = kpisOf([rowOf()], null, 'cny')
    assert.equal(kpi.tokens, 0)
    assert.equal(kpi.turns, 0)
    assert.equal(kpi.cost, null)
    assert.equal(kpi.cacheHit, null)
    assert.equal(kpi.costSessions, 0)
    assert.equal(kpi.usageSessions, 0)
    assert.equal(kpi.toolCalls, 0, 'no timing folds to zeroed tools and time')
    assert.equal(kpi.toolsMs, 0)
    assert.equal(kpi.calls, 0)
    assert.equal(kpi.wallMs, 0)
    assert.equal(kpi.tokenParts, null)
    assert.equal(kpi.timing, null)
  })
})

describe('aggregateDays', () => {
  const book = { prices: { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }
  const FEE: SessionCostUsage = { deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 0, output: 40 } } } }

  test('merges every row’s ledger, skipping rows without one', () => {
    const rows = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-15': { tokens: 2, requests: 2 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3 } } } }),
      rowOf(),
    ]
    assert.deepEqual(aggregateDays(rows, book, 'usd'), {
      '2026-09-16': { tokens: 12, requests: 4, sessions: 2, cost: null },
      '2026-09-15': { tokens: 2, requests: 2, sessions: 1, cost: null },
    })
  })

  test('a zeroed day entry is no activity: it counts no session and makes no day', () => {
    const rows = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 0, requests: 0 }, '2026-09-15': { tokens: 3, requests: 1 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 1, requests: 1 } } } }),
    ]
    assert.deepEqual(aggregateDays(rows, book, 'usd'), {
      '2026-09-16': { tokens: 1, requests: 1, sessions: 1, cost: null },
      '2026-09-15': { tokens: 3, requests: 1, sessions: 1, cost: null },
    })
  })

  test('each day’s pricing records merge and price off the book; unpriced days stay null', () => {
    const rows = [
      rowOf({ activity: { days: {
        '2026-09-16': { tokens: 5, requests: 1, cost: FEE },
        '2026-09-15': { tokens: 2, requests: 2 },
      } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } } } } } } }),
      rowOf({ activity: { days: { '2026-09-14': { tokens: 9, requests: 1, cost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 1 } } } } } } } }),
    ]
    const days = aggregateDays(rows, book, 'usd')
    // The DeepSeek peak buckets double the list price: (100·1 + 50·0.1 + 40·2)·2/1e6 plus the
    // second session's (1·1 + 1·2)·2/1e6.
    assert.ok(Math.abs((days['2026-09-16'].cost ?? 0) - 376e-6) < 1e-12)
    assert.equal(days['2026-09-15'].cost, null, 'a day without pricing records prices to nothing')
    assert.equal(days['2026-09-14'].cost, null, 'a model the book cannot price prices to nothing')
  })

  test('a day with no book prices to null', () => {
    const rows = [rowOf({ activity: { days: { '2026-09-16': { tokens: 5, requests: 1, cost: FEE } } } })]
    assert.equal(aggregateDays(rows, null, 'cny')['2026-09-16'].cost, null)
  })
})
