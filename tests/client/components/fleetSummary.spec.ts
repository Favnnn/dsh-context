// FleetSummary — the Fleet tab's overview strip: family-wide stat chips and the progress bar whose
// semantics follow the session shape (shared tasks, else subagent completion, else nothing).

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FleetSummary, type FleetSummaryProps } from '../../../src/client/components/fleetSummary'
import type { AgentForest, AgentNode } from '../../../src/client/agentTree'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import { pricesBookOf } from '../../../src/client/modelPrices'
import { DICT_EN } from '../../../src/client/i18n'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: true, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

const FOREST: AgentForest = {
  nodes: [
    nodeOf('root', { isCurrent: true, running: true, head: { tokens: 500, window: 1000, pct: 50, parts: [] } }),
    nodeOf('w1', { running: true, head: { tokens: 300, window: 1000, pct: 30, parts: [] } }),
    nodeOf('w2', { completed: true, head: { tokens: 200, window: 1000, pct: 20, parts: [] } }),
    nodeOf('w3', { completed: true }),
  ],
  edges: [],
  overflow: 0,
  solo: false,
}

function teamOf(tasks: FleetTeam['tasks']): FleetTeam {
  return {
    members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }],
    tasks,
  }
}

function taskOf(id: string, status: 'pending' | 'in_progress' | 'completed'): FleetTeam['tasks'][number] {
  return { id, subject: id, description: '', status, blockedBy: [], writeScopes: [], ready: false, warnings: [] }
}

function propsOf(over: Partial<FleetSummaryProps> = {}): FleetSummaryProps {
  return {
    forest: FOREST,
    team: null,
    book: null,
    currency: 'usd',
    t: kit.t,
    fmt: kit.fmt,
    ...over,
  }
}

describe('FleetSummary', () => {
  test('stat chips count the family; the subagent progress bar fills without a team', async () => {
    const m = await mount(h(FleetSummary, propsOf()))
    const rendered = text(m.container)
    assert.ok(rendered.includes('4 agents'))
    assert.ok(rendered.includes('2 running'))
    assert.ok(rendered.includes('2 done'))
    assert.ok(rendered.includes('1.0k tokens in context'))
    const progress = query(m.container, '.lc-summary-progress')
    assert.ok(text(progress).includes(DICT_EN['fleet.summary.subs']))
    assert.ok(text(progress).includes('2/3'))
    assert.equal(query(progress, '.lc-tasks-progress-track i')?.style.width, '67%')
    await m.unmount()
  })

  test('shared tasks win the progress bar when the team serves any', async () => {
    const team = teamOf([taskOf('task-1', 'completed'), taskOf('task-2', 'in_progress'), taskOf('task-3', 'pending')])
    const m = await mount(h(FleetSummary, propsOf({ team })))
    const progress = query(m.container, '.lc-summary-progress')
    assert.ok(text(progress).includes(DICT_EN['fleet.summary.tasks']))
    assert.ok(text(progress).includes('1/3'))
    await m.unmount()
  })

  test('a solo session lists no progress bar and no done chip', async () => {
    const solo: AgentForest = {
      nodes: [nodeOf('root', { isCurrent: true, running: true })],
      edges: [],
      overflow: 0,
      solo: true,
    }
    const m = await mount(h(FleetSummary, propsOf({ forest: solo })))
    assert.equal(queryAll(m.container, '.lc-summary-progress').length, 0)
    assert.ok(!text(m.container).includes(DICT_EN['fleet.summary.done'].replace('{n}', '')))
    assert.equal(queryAll(m.container, '.lc-agents-chip').length, 2, 'count + running only — no tokens without heads')
    await m.unmount()
  })

  test('the cost chip appears once a node prices against the book', async () => {
    const book = pricesBookOf({
      deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    })
    assert.ok(book !== null)
    const ledger = { 'deepseek-official': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000 } } } }
    const priced: AgentForest = {
      ...FOREST,
      nodes: [...FOREST.nodes.slice(0, 1), nodeOf('w1', { running: true, costUsage: ledger })],
    }
    const m = await mount(h(FleetSummary, propsOf({ forest: priced, book })))
    assert.ok(text(m.container).includes('est.'), 'the cost chip renders')
    assert.ok(text(m.container).includes('$0.45'))
    await m.unmount()

    // A book without the model prices nothing — the chip stays out.
    const bare = pricesBookOf({ other: { models: { 'x': { cost: { input: 1, output: 1, cache_read: 1 } } } } })
    const m2 = await mount(h(FleetSummary, propsOf({ forest: priced, book: bare })))
    assert.ok(!text(m2.container).includes('est.'))
    await m2.unmount()
  })

  test('zh chrome and the overflow count ride along', async () => {
    const zh = makeKit('zh')
    const m = await mount(h(FleetSummary, propsOf({ forest: { ...FOREST, overflow: 2 }, t: zh.t, fmt: zh.fmt })))
    assert.ok(text(m.container).includes('6 个 Agent'))
    await m.unmount()
  })
})
