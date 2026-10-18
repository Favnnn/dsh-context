// OverviewPanel (src/client/components/overviewPanel.tsx) rendered in the layout's keyed `main` panel: mounting it IS
// opening it (the shell unmounts on panel switch), so no open flag exists.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { dayKeyOf } from '../../../src/shared/days'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover, until, type Mounted } from '../helpers/kit'

const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
}

const NOW = Date.now()
const TODAY = dayKeyOf(NOW) ?? ''
const YESTERDAY = dayKeyOf(NOW - 86_400_000) ?? ''
/** Local midnight of NOW — the "today" range's floor, so today's session stays inside it whatever hour the spec runs. */
const MIDNIGHT = new Date(new Date(NOW).setHours(0, 0, 0, 0)).getTime()

/** A wire-shaped timeline head. */
function timeline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
    contextWindow: 1000,
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    counts: { turns: 3, steps: 5, injects: 1, compactions: 0, prunes: 0 },
    cost: { deepseek: { 'deepseek-v4-flash': { peak: { uncached: 1000, cacheRead: 500, cacheWrite: 0, output: 250 } } } },
    timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7 },
    ...over,
  }
}

/** The three-session snapshot: current + folded, older + cheap, stale + bare. */
function sessionsSnapshot(): { ids: string[]; byId: Record<string, Record<string, unknown>>; current: string; phase: string } {
  return {
    ids: ['a', 'b', 'c'],
    byId: {
      a: {
        displayTitle: 'alpha session',
        cwd: '/repo/alpha',
        updatedAt: MIDNIGHT,
        running: true,
        projectionValues: {
          contextTimeline: timeline(),
          contextActivity: { days: { [TODAY]: { tokens: 100, requests: 2 }, [YESTERDAY]: { tokens: 50, requests: 1 } } },
        },
      },
      b: {
        displayTitle: 'beta session',
        cwd: '/repo/beta',
        updatedAt: NOW - 10 * 86_400_000,
        projectionValues: {
          contextTimeline: timeline({ current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }, cost: undefined }),
          contextActivity: { days: { [YESTERDAY]: { tokens: 25, requests: 1 } } },
        },
      },
      c: {
        title: 'gamma session',
        updatedAt: NOW - 40 * 86_400_000,
      },
    },
    current: 'a',
    phase: 'ready',
  }
}

const workspacesSnapshotValue = {
  items: [{ workspaceId: 'w1', title: 'workspace-one', path: '/repo', sessionIds: ['a'] }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
}

const useHookOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T): T => sel(snapshot))

function makeCtx(sessions: Record<string, unknown> = {}): TestClientCtx {
  return new TestClientCtx({ services: { sessions } })
}

async function openPanel(
  ctx: TestClientCtx,
  props: Record<string, unknown> = {},
): Promise<{ m: Mounted; Panel: ReturnType<typeof makeOverviewPanel> }> {
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit())
  const allProps = {
    useSessions: useHookOf(sessionsSnapshot()),
    useWorkspaces: useHookOf(workspacesSnapshotValue),
    ...props,
  }
  const m = await mount(h(Panel, allProps))
  // The price book's first fetch resolves a microtask or two behind the mount; a second act window keeps its notify inside act.
  await flush()
  return { m, Panel }
}

const backfillPosts: string[] = []

/** One day cell of the page's portaled calendar picker, by its day key. */
function calendarDay(key: string): HTMLElement {
  const el = queryAll(document.body, '.lc-dp-cell').find(d => d.getAttribute('aria-label') === key)
  assert.ok(el !== undefined, `the calendar drew ${key}`)
  return el
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
  backfillPosts.length = 0
  // The heading's balance capsule POSTs its own route on mount (client/balance.ts);
  // only the warm-up trigger is this spec's subject.
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const route = String(url)
    if (route.endsWith('/backfill')) backfillPosts.push(route)
    return { ok: true, json: async () => ({}) }
  })
})

afterEach(async () => {
  resetModelPrices()
  vi.unstubAllGlobals()
  await new Promise(resolve => setTimeout(resolve, 1))
})

describe('OverviewPanel', () => {
  test('renders the KPI band, heatmap, and session cards; summons the warm-up and refreshes the list on mount', async () => {
    let pulls = 0
    const ctx = makeCtx({ refresh: () => { pulls++; return Promise.resolve() } })
    const { m } = await openPanel(ctx)
    assert.equal(pulls, 1, 'the baseline re-pull fires on mount')
    assert.deepEqual(backfillPosts, ['api/dsh-context/backfill'], 'the warm-up trigger POST fires on mount')
    assert.ok(text(m.container).includes('Context Insights'))
    // The page chrome: the section's one scroll region carries the centered
    // content column — the page heading, then the 1:1 first row (the KPI
    // band beside the last-7-days usage chart), the aggregate stats pair, and the insight/session body.
    const page = query(m.container, 'section.lc-ov-page')
    assert.equal(page.getAttribute('aria-label'), 'Context Insights')
    const scrollRows = [...query(m.container, '.lc-ov-pagecontent').children].map(el => el.className.split(' ')[0])
    assert.deepEqual(scrollRows, ['lc-ov-pagehead', 'lc-ov-first', 'lc-ov-stats', 'lc-ov-body'])
    assert.equal(query(m.container, '.lc-ov-pagehead h1.lc-ov-pagetitle').textContent, 'Context Insights')
    assert.ok(query(m.container, '.lc-ov-pagehead').hasAttribute('data-window-drag'), 'the head is the desktop window drag area')
    // The pair's halves: the KPI band's six cells.
    assert.equal(queryAll(m.container, '.lc-ov-first > .lc-ov-kpis .lc-stat').length, 6)
    assert.ok(query(m.container, '.lc-ov-first > .lc-card.lc-ov-usage') !== null, 'the usage chart rides the row')
    // KPI band: 2 sessions in the 30d range, 1750 tokens billed, priced cost, cache hit.
    const labels = queryAll(m.container, '.lc-stat-label').map(el => el.textContent)
    assert.deepEqual(labels, ['Sessions', 'Tokens Used', 'Cost', 'Cache Hit', 'Tool Calls', 'Active Time'])
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(values[0], '2')
    assert.equal(values[1], '1.8k')
    assert.ok(values[2].startsWith('$'), 'priced from the book')
    assert.equal(values[3], '33.33%')
    // Tools + active time: both timed sessions fold into the band (7 calls each).
    assert.equal(values[4], '14')
    assert.equal(values[5], '3m0s')
    assert.ok(text(m.container).includes('tool runs 40.0s'), 'the tool calls cell qualifies with the summed run time')
    assert.ok(text(m.container).includes('8 model calls'), 'the active-time cell qualifies with the model-call count')
    // Cost and cache hit qualify with the session count each figure covers
    // (only session a carries usage; b folds no cost at all).
    const subs = queryAll(m.container, '.lc-stat-sub').map(el => el.textContent)
    assert.deepEqual(subs.slice(2, 4), ['1 of 2 sessions priced', 'across 1 sessions'])
    // The aggregate stats row: the range's Token Stats ring folded into the
    // Context tab's OWN composition categories (every fixture category is
    // billed > 0 here, output exact) beside the Timing Stats ring (the summed
    // totals, un-split — no fixture carries a decode split).
    const statsCards = queryAll(m.container, '.lc-ov-stats > .lc-card')
    assert.equal(statsCards.length, 2)
    assert.equal(query(statsCards[0], '.lc-donut-center b').textContent, '1.8k')
    assert.deepEqual(queryAll(statsCards[0], '.lc-sl-label').map(el => el.textContent), [
      'System Prompt', 'Tool Schemas', 'User Messages', 'Injected Context',
      'Skill Injections', 'Assistant Messages', 'Tool Results', 'Output',
    ])
    assert.equal(query(statsCards[1], '.lc-donut-center b').textContent, '3m0s')
    assert.ok(text(statsCards[1]).includes('LLM Gen'))
    assert.ok(queryAll(m.container, 'button.lc-heat-cell').length >= 2)
    // Cards: a (current, running, grouped), b, and c is outside the 30d range.
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 2)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(cards[0]).includes('workspace-one'), 'the breadcrumb group joined')
    assert.ok(text(cards[0]).includes('alpha'), 'the project basename joined')
    await m.unmount()
  })

  test('the coverage picker folds archived sessions in by default and its scopes split the page', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {
      useWorkspaces: useHookOf({ ...workspacesSnapshotValue, archivedSessionIds: ['b'] }),
    })
    // Default 'all': the archived session folds back into every band, tagged on its card.
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'incl. 1 archived')
    let cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 2)
    const betaCard = cards.find(c => text(c).includes('beta session'))
    assert.ok(betaCard !== undefined && text(betaCard).includes('Archived'), 'the archived card carries the tag')
    const select = query<HTMLSelectElement>(m.container, 'select.lc-ov-cover')
    assert.deepEqual([...select.options].map(o => o.textContent), ['All (show archived)', 'Hide archived', 'Archived only'])
    // 'active' restores the lighter list; the sub-line names what the full list holds.
    await actSelect(select, 'active')
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Active Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'of 3 total')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1', 'the archived session leaves the KPI band')
    cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    // 'archived' flips the split: only the tagged session in range stays.
    await actSelect(select, 'archived')
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Archived Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'of 3 total')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1')
    const archCards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(archCards.length, 1)
    assert.ok(text(archCards[0]).includes('beta session'))
    await m.unmount()
  })

  test('an archived card click opens nothing (dsh refuses archived sessions)', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({
      services: {
        uiWorkspace: { openSession: (id: string) => { opened.push(id) } },
        sessions: {},
      },
    })
    const { m } = await openPanel(ctx, {
      useWorkspaces: useHookOf({ ...workspacesSnapshotValue, archivedSessionIds: ['b'] }),
    })
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-grid > .lc-ov-session').find(c => text(c).includes('beta session'))!)
    assert.deepEqual(opened, [], 'the archived card never navigates')
    await m.unmount()
  })

  test('range switching re-scopes the KPI band and the grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.equal(rangeButtons.length, 4)
    // The chip reads the LIVE window, so every preset prints its own days.
    const span = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    const thirty = new Date(NOW - 30 * 86_400_000)
    assert.deepEqual(span(), [dayKeyOf(thirty.getTime()), TODAY], '30d shows the thirty days it covers')
    await click(rangeButtons[3]) // All
    assert.deepEqual(span(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 3, 'the stale session joins')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '3')
    await click(rangeButtons[0]) // Today
    assert.deepEqual(span(), [TODAY, TODAY], "today's own day on both ends")
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, "only today's session stays")
    await click(rangeButtons[1]) // Last 7 days
    assert.deepEqual(span(), [dayKeyOf(NOW - 7 * 86_400_000), TODAY])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, 'only the freshest stays')
    await click(rangeButtons[2]) // back to 30d
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()
  })

  test('a picked calendar range scopes the page and hands the presets back', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    await click(query(m.container, '.lc-dp-trigger'))
    await click(calendarDay(YESTERDAY))
    await click(calendarDay(TODAY))
    assert.ok(query(m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'), 'the chip carries the picked range')
    assert.deepEqual(
      queryAll(m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the head names both ends, start first',
    )
    // The window closes at both ends: only the session last touched inside it stays.
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1', 'the KPI band narrowed with it')
    assert.ok(
      rangeButtons.every(b => !b.className.includes('lc-gran-on')),
      'a picked range and a preset are never both lit',
    )
    await click(rangeButtons[3])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 3, 'the stale session joins again')
    assert.ok(!query(m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'))
    await m.unmount()
  })

  test('a backwards pick still scopes the window the short way round', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    await click(query(m.container, '.lc-dp-trigger'))
    // The end day first, then a start day BEFORE it: the pair swaps rather
    // than leaving the page with a window that runs backwards.
    await click(calendarDay(TODAY))
    await click(calendarDay(YESTERDAY))
    assert.deepEqual(
      queryAll(m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the picked pair is sorted, start day first',
    )
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, 'the same window a forward pick would have left')
    await m.unmount()
  })

  test('the heatmap day pin filters the grid and the chip clears it', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const cells = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    const todayCell = cells.find(c => c.getAttribute('aria-label')?.startsWith(TODAY))
    assert.ok(todayCell !== undefined, 'today has a data cell')
    await click(todayCell)
    assert.ok(query(m.container, '.lc-ov-day-chip'), 'the day chip appears')
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'), 'only the session active that day stays')
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-day-chip'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'the chip clear restores')
    // Pin and unpin via the cell itself.
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'both sessions were active yesterday')
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-day-chip').length, 0)
    await m.unmount()
  })

  test('the skill card pins the session list to the skill’s loaders; the chip and the row release it', async () => {
    const ctx = makeCtx()
    // Session a loaded 'tdd' today; b's ledger carries no skills.
    const snap = sessionsSnapshot()
    const aDays = (snap.byId.a.projectionValues as { contextActivity: { days: Record<string, Record<string, unknown>> } }).contextActivity.days
    aDays[TODAY] = { ...aDays[TODAY], skills: { tdd: { n: 2, last: NOW - 1000 } } }
    const skillPosts: unknown[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const route = String(url)
      if (route.endsWith('/skills')) {
        skillPosts.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
        return {
          ok: true,
          json: async () => ({ ok: true, value: { skills: [{ name: 'tdd', description: 'Test-driven.', path: '/p/tdd/SKILL.md', source: 'user-agents' }] } }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })
    const { m } = await openPanel(ctx, { useSessions: useHookOf(snap) })
    await flush() // the catalog read lands
    assert.deepEqual(skillPosts, [{ cwd: '/repo/alpha', sessionId: 'a' }], 'the catalog read anchors on the current session')
    const skillRow = query<HTMLButtonElement>(m.container, 'button.lc-ov-skill')
    assert.ok(text(skillRow).includes('tdd'))
    await hover(skillRow)
    assert.ok(text(document.querySelector('#lc-skilltip-bubble') as HTMLElement).includes('Test-driven.'), 'the catalog’s description joins the hover card')
    await unhover(skillRow)
    await click(skillRow)
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the skill filter"]')
    assert.ok(text(chip).includes('Skill · tdd'))
    assert.ok(text(query(m.container, '.lc-ov-skill-detail')).includes('/p/tdd/SKILL.md'))
    await click(chip)
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0, 'the detail block leaves with the pin')
    // Re-pin and release via the row itself.
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-skill'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-skill'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()
  })

  test('the metric toggle re-prices the heatmap between steps and sessions', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const todayCellClass = (): string | undefined =>
      queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
        .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))?.className
    assert.ok(todayCellClass()?.includes('lc-heat-4'), 'steps mode (default): today holds the steps peak')
    const metricButtons = queryAll<HTMLButtonElement>(m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.deepEqual(metricButtons.map(b => b.textContent), ['Sessions', 'Steps'])
    assert.ok(metricButtons[1].className.includes('lc-gran-on'), 'steps starts selected')
    await click(metricButtons[0])
    const after = queryAll<HTMLButtonElement>(m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.ok(after[0].className.includes('lc-gran-on'), 'the click selects sessions')
    assert.ok(!after[1].className.includes('lc-gran-on'))
    // Sessions: today had one of the window's two active sessions.
    assert.ok(todayCellClass()?.includes('lc-heat-2'), 'sessions mode re-prices today down its own scale')
    await m.unmount()
  })

  test('search and sort steer the grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({
        ...sessionsSnapshot(),
        ids: ['a', 'b', 'c'],
        byId: {
          ...sessionsSnapshot().byId,
          c: { ...(sessionsSnapshot().byId.c as object), updatedAt: NOW - 86_400_000 },
        },
      }),
    })
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    await actType(input, 'beta')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    assert.ok(text(m.container).includes('beta session'))
    await actType(input, '/repo/a')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    await actType(input, 'zzz')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    assert.ok(text(m.container).includes('No sessions match'))
    await actType(input, '')
    // Sort: tokens puts the billed session first; context puts the largest current first.
    const sortButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-list-head .lc-gran-btn')
    assert.equal(sortButtons.length, 3)
    await click(sortButtons[1]) // Tokens
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[2]) // Context
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[0]) // Recent
    await m.unmount()
  })

  test('the group chips filter the grid (All / workspace / Ungrouped), toggling on and off', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All2', 'workspace-one1', 'Ungrouped1'])
    await click(chips[1])
    let cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1].className.includes('lc-ov-chip-on'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('beta session'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[0])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()
  })

  test('a selection whose group fell out of scope keeps a phantom chip (one click out)', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1]) // workspace-one
    // Filter everything away with a query: the selection's chip stays, lit, at 0.
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    await actType(input, 'zzz')
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All0', 'workspace-one0'])
    assert.ok(chips[1].className.includes('lc-ov-chip-on'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    await m.unmount()
  })

  test('a card click opens the session through the harness verb', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { uiWorkspace: { openSession: (id: string) => { opened.push(id) } } } })
    const { m } = await openPanel(ctx)
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-grid > .lc-ov-session'))
    // The verb's own navigation returns the center column to the conversation
    // (selectPanel(null)); the shell unmounts the page — nothing here closes.
    assert.deepEqual(opened, ['a'])
    await m.unmount()
  })

  test('the settings chip beside the title runs the preferences jump', async () => {
    // The harness chrome the jump drives (settingsJump.ts): the Plugins panel
    // entry first, then the bundle card's open control (the one non-switch button inside the card), both click-tracked.
    const clicks: string[] = []
    const chrome = document.createElement('div')
    chrome.innerHTML = `
      <button aria-label="Plugins"></button>
      <div data-plugin-package="dsh-context">
        <button role="switch"></button>
        <button>Context</button>
      </div>`
    for (const b of [...chrome.querySelectorAll('button')]) {
      b.addEventListener('click', () => { clicks.push(b.getAttribute('aria-label') ?? (b.textContent ?? '')) })
    }
    document.body.appendChild(chrome)
    try {
      const ctx = makeCtx()
      const { m } = await openPanel(ctx)
      const chip = query<HTMLButtonElement>(m.container, '.lc-ov-settings')
      // The chip rides the heading, directly after the title (the long hint moved onto the hover title).
      assert.equal(chip.textContent, 'Plugin Settings')
      assert.equal(chip.title, 'Open plugin settings')
      const head = query(m.container, '.lc-ov-pagehead')
      assert.equal(head.children[0].className, 'lc-ov-pagetitle')
      assert.equal(head.children[1], chip)
      await click(chip)
      assert.deepEqual(clicks, ['Plugins'], 'the jump clicked the Plugins panel entry synchronously')
      await until(() => clicks.length > 1, 'the jump never reached the bundle card open control')
      assert.equal(clicks[1], 'Context')
      await m.unmount()
    } finally {
      chrome.remove()
    }
  })

  test('hovering a heat cell portals its tip to <body>; leaving hides it', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const cell = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
      .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))
    assert.ok(cell !== undefined)
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const bubble = document.body.querySelector('#lc-hovertip-bubble')
    assert.ok(bubble !== null, 'the portaled bubble mounted')
    assert.ok(bubble.textContent.startsWith(TODAY), 'the cell label rides the bubble')
    assert.equal(cell.getAttribute('aria-describedby'), 'lc-hovertip-bubble')
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: m.container }))
    })
    assert.equal(document.body.querySelector('#lc-hovertip-bubble'), null, 'leaving the anchor hides the bubble')
    assert.equal(cell.getAttribute('aria-describedby'), null)
    await m.unmount()
  })

  test('degraded states: unavailable list, empty list, no activity', async () => {
    const ctx = makeCtx()
    const bare = await openPanel(ctx, { useSessions: undefined, useWorkspaces: undefined })
    assert.ok(text(bare.m.container).includes('The session list is unavailable'))
    await bare.m.unmount()

    const empty = await openPanel(ctx, {
      useSessions: useHookOf({ ids: [], byId: {}, phase: 'ready' }),
      useWorkspaces: useHookOf({ items: [] }),
    })
    assert.ok(text(empty.m.container).includes('No sessions yet'))
    assert.ok(text(empty.m.container).includes('No activity yet'))
    await empty.m.unmount()

    const noTimeline = await openPanel(ctx, {
      useSessions: useHookOf({
        ids: ['x'],
        byId: { x: { displayTitle: 'plain session', updatedAt: NOW - 1000 } },
        phase: 'ready',
      }),
    })
    assert.ok(text(noTimeline.m.container).includes('No context data yet'))
    const kpiValues = queryAll(noTimeline.m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(kpiValues[1], '0')
    assert.equal(kpiValues[2], '—', 'nothing priced without cost buckets')
    assert.equal(kpiValues[3], '—', 'no cache hit without billed input')
    assert.equal(kpiValues[4], '0', 'no tool calls without timing')
    assert.equal(kpiValues[5], '—', 'no active time without timing')
    assert.ok(text(noTimeline.m.container).includes('No billed tokens in this range'))
    assert.ok(text(noTimeline.m.container).includes('No timing data yet'))
    await noTimeline.m.unmount()
  })

  test('the zh locale renders translated chrome and CNY cost', async () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit('zh'))
    const m = await mount(h(Panel, {
      useSessions: useHookOf(sessionsSnapshot()),
      useWorkspaces: useHookOf(workspacesSnapshotValue),
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文洞察'))
    assert.ok(text(m.container).includes('全部会话'), 'the All default labels the sessions card and the coverage option')
    assert.ok(text(m.container).includes('仅显示已归档'), 'the coverage options ride the zh dictionary too')
    assert.ok(text(m.container).includes('Token 统计'), 'the aggregate stats row rides the zh dictionary too')
    assert.ok(text(m.container).includes('系统提示词'), 'the Context tab\'s composition categories render in zh')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-ov-settings').title, '打开插件设置', 'the settings chip rides the zh dictionary too')
    await flush() // the price book lands
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.ok(values[2].startsWith('¥'), 'CNY under the zh locale')
    await m.unmount()
  })

  test('a hostile session seat degrades to the unavailable note instead of an error card', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, { useSessions: () => { throw new Error('boom') } })
    assert.ok(text(m.container).includes('The session list is unavailable'))
    await m.unmount()
  })

  test('an unpriceable model dashes the card cost', async () => {
    const ctx = makeCtx()
    const sparse = timeline({
      current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      cost: { deepseek: { 'no-such-model': { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({
        ids: ['s'],
        byId: {
          s: { displayTitle: 'sparse session', updatedAt: NOW - 1000, projectionValues: { contextTimeline: sparse } },
        },
        phase: 'ready',
      }),
    })
    await flush() // the price book lands
    // The card's cost: buckets exist but the book prices no such model → the dash.
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.equal(values[2], '—')
    await m.unmount()
  })

  test('a locale service without getLocale falls back to USD', async () => {
    // A hand-rolled ctx: the locale face carries no getLocale at all.
    const bare = {
      locale: {
        register: () => () => {},
        bind: () => makeKit().t,
      },
      get: () => undefined,
    }
    const Panel = makeOverviewPanel(bare as never, makeKit())
    const m = await mount(h(Panel, {
      useSessions: useHookOf(sessionsSnapshot()),
      useWorkspaces: useHookOf(workspacesSnapshotValue),
    }))
    await flush()
    await flush() // the price book lands
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.ok(values[2].startsWith('$'), 'USD when the locale face cannot report an active locale')
    await m.unmount()
  })

  test('the grid pages at 12 cards; the pager steps and a filter change re-anchors it', async () => {
    const ctx = makeCtx()
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    const byId: Record<string, Record<string, unknown>> = {}
    ids.forEach((id, i) => { byId[id] = { displayTitle: `session ${i}`, updatedAt: NOW - i * 60_000 } })
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({ ids, byId, current: 's0', phase: 'ready' }),
      useWorkspaces: useHookOf({ items: [] }),
    })
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 12, 'the first page caps at 12 cards')
    assert.ok(text(m.container).includes('Page 1 of 3'))
    const btns = () => queryAll<HTMLButtonElement>(m.container, '.lc-ov-pager-btn')
    assert.ok(btns()[0].disabled, 'prev sits out on the first page')
    await click(btns()[1])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 12, 'the middle page is full')
    await click(btns()[1])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 6, 'the tail page renders the rest')
    assert.ok(text(m.container).includes('Page 3 of 3'))
    assert.ok(btns()[1].disabled, 'next sits out on the last page')
    await click(btns()[0])
    assert.ok(text(m.container).includes('Page 2 of 3'), 'prev steps back')
    // Typing while on the last page: the reset lands on the first page of the narrowed set.
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), 'session 2')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 11, "'session 2' matches 2 and 20–29")
    assert.ok(!text(m.container).includes('Page 2 of 3'), 'the pager drops once one page remains')
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), '')
    assert.ok(text(m.container).includes('Page 1 of 3'), 'clearing the query lands on the first page, not the stale one')
    await m.unmount()
  })

  test('typing keeps the search input focused (re-renders never touch the active element)', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    input.focus()
    await actType(input, 'beta')
    await actType(input, 'bet')
    assert.equal(document.activeElement, input, 'every re-render leaves the focused input alone')
    await m.unmount()
  })
})

/** Type into an input through the React change path (native setter + input event, act-wrapped). */
async function actType(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Pick a coverage option through the React change path (native setter + change event, act-wrapped). */
async function actSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
