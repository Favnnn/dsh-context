// FleetView integration — the panels over one family: the overview strip, the team projection
// (list-row and direct seats), pin/hover/select steering across the graph and the boards, and the
// comms scan off the stubbed fleet route.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, hover, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { projectionsFor, richTimeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

const TEAM_PROJECTION = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    // A member whose session left the list: label resolution falls back to the roster name.
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/'], ready: false, writeScopeWarnings: [] },
  ],
}

/** A stable-snapshot sessions face (useSyncExternalStore loops on a fresh object per read). */
function familySessions() {
  const snapshot = {
    byId: {
      root: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: TEAM_PROJECTION } },
      w1: {
        parentId: 'root', origin: 'subagent', running: true, updatedAt: 8,
        projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' }, subagentTiming: { settledMs: 42000 } },
      },
      // A plain subagent outside the team roster: the members board's other-agents section.
      w2: {
        parentId: 'root', origin: 'subagent', running: false, updatedAt: 6,
        projectionValues: { subagent: { mode: 'one-shot', label: 'side-quest' }, subagentTiming: { settledMs: 9000, lastTurnCompleted: true } },
      },
    },
  }
  return {
    list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} },
  }
}

/** The fleet route stub: a delegation prompt + descriptor per session, and one relay into w1. */
function stubFleetRoute(): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const { sessionId } = JSON.parse(init.body) as { sessionId: string }
    const value = sessionId === 'w1'
      ? {
        descriptor: { mode: 'continuable', label: 'worker-bee', provider: 'spawn', agentModel: 'deepseek-v4' },
        initialPrompt: 'Review the schema parser.',
        messages: [
          { seq: 9, time: 1_700_000_000_000, kind: 'relay', from: 'root', text: 'how far along?' },
          { seq: 8, time: 1_699_999_000_000, kind: 'relay', from: 'w9', text: 'ghost says hi' },
          { seq: 7, time: 1_699_998_000_000, kind: 'relay', from: 'stranger', text: 'who dis' },
          { seq: 6, time: 1_699_997_000_000, kind: 'relay', from: 'root', text: 'second from lead' },
          // A self-addressed row (a member noting to itself) joins the recipient list once.
          { seq: 5, time: 1_699_996_000_000, kind: 'relay', from: 'w1', text: 'note to self' },
          // An unattested sender (an old log shape) still lists under the recipient.
          { seq: 4, time: 1_699_995_000_000, kind: 'mailbox', text: 'anonymous delivery' },
        ],
        truncated: false,
      }
      : { messages: [], truncated: false }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
  })
}

function makeView(ctx: TestClientCtx, useKit = kit) {
  return makeFleetView(asClientCtx(ctx), useKit, makeAgentHeads())
}

describe('FleetView — the panels over one family', () => {
  test('the other-agents card open button jumps to the session', async () => {
    stubFleetRoute()
    const opened = new Array<string>()
    const ctx = new TestClientCtx({
      services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const cards = queryAll(m.container, '.lc-member-card')
    await click(query(cards[cards.length - 1], '.lc-member-open'))
    assert.deepEqual([...opened], ['w2'])
    await m.unmount()
    ctx.dispose()
  })

  test('the other-agents card open button prefers the right Sidebar\'s subagent chat', async () => {
    stubFleetRoute()
    const opened: { address: string; options: unknown }[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: familySessions(),
        sidebarRight: { openResource: (address: string, options?: unknown) => { opened.push({ address, options }) } },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const cards = queryAll(m.container, '.lc-member-card')
    await click(query(cards[cards.length - 1], '.lc-member-open'))
    // The aside resource is addressed by the node's own direct parent and subagent mode.
    assert.deepEqual(opened, [{
      address: 'dsh-resource://subagentchat/session/w2?parent=root&mode=one-shot',
      options: { kind: 'subagentchat', preferNewPane: true },
    }])
    await m.unmount()
    ctx.dispose()
  })

  test('overview strip, team chip, members board, task board, and comms all render off the one derivation', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    // The overview strip: family stats plus the shared-tasks progress bar.
    const summary = query(m.container, '.lc-summary')
    assert.ok(text(summary).includes('3 agents'))
    assert.ok(text(summary).includes('2 running'))
    assert.ok(text(summary).includes(DICT_EN['fleet.summary.tasks']))
    assert.ok(text(summary).includes('0/1'))
    // The network card header carries the team chip.
    assert.ok(text(query(m.container, '.lc-agents')).includes('team · 3 members · 1 tasks'))
    // The members board: team cards (the ghost's roster row included) + the other-agents
    // section (w2, the plain subagent) in the same card form.
    const board = query(m.container, '.lc-members')
    assert.ok(text(board).includes('worker-bee'))
    assert.ok(text(board).includes(DICT_EN['fleet.board.others']))
    assert.equal(queryAll(board, '.lc-member-card').length, 4)
    assert.ok(text(query(m.container, '.lc-tasks')).includes('schema parsing'))
    // The comms panel opens collapsed.
    assert.ok(text(query(m.container, '.lc-comms')).includes('Scan 3 sessions'))
    // The network card stands alone: the boards beside it carry the agent detail.
    assert.equal(queryAll(m.container, '.lc-inspector').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('hovering a member card lights its graph card; pinning sticks and rings both', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    const card = queryAll(m.container, '.lc-member-card')[1]
    await hover(card)
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-hover'))
    // The lift interlocks both ways: pointing at the graph card lifts its member card.
    await hover(query(m.container, '[data-agent="w1"]'))
    assert.ok(queryAll(m.container, '.lc-member-card')[1].className.includes('lc-member-hover'))
    await click(card)
    // The pin survives the hover leaving, and the graph card rings.
    await hover(queryAll(m.container, '.lc-member-card')[0])
    const node = query(m.container, '[data-agent="w1"]')
    assert.ok(node.className.includes('lc-agent-pinned'))
    assert.ok(!node.className.includes('lc-agent-hover'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null, 'the member card echoes the pin')

    // The member's landed detail fills its card's model, and its owned task its count.
    await until(() => text(query(m.container, '.lc-members')).includes('deepseek-v4'), 'the descriptor never landed')
    assert.ok(text(query(m.container, '.lc-members')).includes('1 active tasks'))
    await m.unmount()
    ctx.dispose()
  })

  test('a graph-node pick rings the card and narrows the task board to its tasks', async () => {
    stubFleetRoute()
    const opened = new Array<string>()
    const ctx = new TestClientCtx({
      services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    // Picking a member node: the ring lands and the owner filter narrows the task board.
    await click(query(m.container, '[data-agent="w1"]'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('worker-bee'))
    assert.deepEqual([...opened], [], 'a pick never jumps')

    // A row pick on the narrowed board unfolds the card; the pin and the narrowing stay.
    await click(query(m.container, '[data-task="task-1"]'))
    assert.ok(query(m.container, '[data-task="task-1"] .lc-ts-card') !== null, 'the opened card boxes up')
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))

    // The band head's pick releases the pin and the narrowing together.
    await click(query(m.container, '.lc-tasks-group-head .lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    // …and the delegation row pairs by session id through its opened agent box.
    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('side-quest'), 'the chip names the subagent, not its id')
    await click(query(m.container, '[data-task="w2"]'))
    await click(query(m.container, '[data-task="w2"] .lc-team-task-box-agent .lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    // Picking a non-member node moves the ring and narrows the task board to its own delegation.
    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(query(m.container, '[data-agent="w2"]').className.includes('lc-agent-pinned'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('side-quest'), 'the chip names the subagent, not its id')

    // Picking the pinned node again releases both.
    await click(query(m.container, '[data-agent="w2"]'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)

    // Unpinning a member releases its owner filter when it still points at them…
    await click(query(m.container, '[data-agent="w1"]'))
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('worker-bee'))
    await click(query(m.container, '[data-agent="w1"]'))
    assert.equal(queryAll(m.container, '.lc-tasks-filter').length, 0)
    // …but a filter the reader moved on from is left alone.
    await click(query(m.container, '[data-agent="w1"]'))
    await click(query(m.container, '.lc-tasks-filter'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    await click(query(m.container, '[data-agent="w1"]'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a task-board owner pick toggles the pin on the graph and the member card', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    await click(query(m.container, '.lc-team-task-owner'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null)
    // A second pick on the same owner releases the pin.
    await click(query(m.container, '.lc-team-task-owner'))
    assert.equal(queryAll(m.container, '.lc-agent-pinned').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('the comms scan merges the family logs into one timeline', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    await click(query(m.container, '.lc-comms-scan'))
    await until(() => queryAll(m.container, '.lc-comms-row').length === 6, 'the relays never surfaced')
    const rows = queryAll(m.container, '.lc-comms-row')
    assert.ok(text(rows[0]).includes('Main Agent'))
    assert.ok(text(rows[0]).includes('worker-bee'))
    assert.ok(text(rows[0]).includes('how far along?'))
    // Label resolution: a member outside the forest names itself off the roster, a stranger its raw id.
    assert.ok(text(rows[1]).includes('ghost-nine'))
    assert.ok(text(rows[2]).includes('stranger'))

    // A comms peer click pins the sender, ringing its graph card and its member card.
    await click(queryAll(rows[0], '.lc-comms-peer')[0])
    assert.ok(query(m.container, '[data-agent="root"]').className.includes('lc-agent-pinned'))
    assert.ok(query(m.container, '.lc-member-pinned') !== null)

    // Pinning a sender outside the family releases instead of ringing a member that has no graph card.
    await click(queryAll(rows[1], '.lc-comms-peer')[0])
    await until(() => queryAll(m.container, '.lc-agent-pinned, .lc-member-pinned').length === 0, 'the ghost pin never released')

    // A graph pick narrows the comms timeline by session id; the pick chip clears it.
    await click(query(m.container, '[data-agent="w2"]'))
    assert.ok(text(query(m.container, '.lc-comms')).includes(DICT_EN['fleet.comms.noMatch']), 'side-quest rode no relays')
    await click(query(m.container, '.lc-comms .lc-tasks-filter'))
    await until(() => queryAll(m.container, '.lc-comms-row').length === 6, 'the rows never returned')
    await m.unmount()
    ctx.dispose()
  })

  test('a fleet-detail read that serves nothing leaves the boards standing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 } as Response))
    // Fresh session ids: the page-scope read ledger carries no settled line for them.
    const team = {
      members: [
        { id: 'cold-root', name: 'cold-lead', role: 'lead', phase: 'active' },
        { id: 'cold-w1', name: 'cold-worker', role: 'teammate', phase: 'active' },
      ],
      tasks: [],
    }
    const snapshot = {
      byId: {
        'cold-root': { displayTitle: 'Cold Lead', running: false, updatedAt: 3, projectionValues: { agentTeam: team } },
        'cold-w1': { parentId: 'cold-root', origin: 'subagent', running: false, updatedAt: 2, projectionValues: { subagent: { mode: 'one-shot', label: 'cold-worker' } } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'cold-root', useProjection: projectionsFor(richTimeline()) }))

    // The member cards stand on the projection's own roster, with no reply to join.
    assert.ok(text(query(m.container, '.lc-members')).includes('cold-worker'))
    // Every read lands as a null detail: the scan settles empty instead of crashing or spinning.
    await click(query(m.container, '.lc-comms-scan'))
    await until(() => text(query(m.container, '.lc-comms')).includes(DICT_EN['fleet.comms.empty']), 'the scan never settled')
    await m.unmount()
    ctx.dispose()
  })

  test('the direct projection seat serves the team when the viewed session leads it', async () => {
    stubFleetRoute()
    // Rows carry no agentTeam value; the tab's own projection does.
    const snapshot = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        w1: { parentId: 'root', origin: 'subagent', running: false, updatedAt: 8 },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'root',
      useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM_PROJECTION }),
    }))
    assert.ok(query(m.container, '.lc-members') !== null)
    assert.ok(query(m.container, '.lc-tasks') !== null)
    // The cockpit row: the network on the left, the members board over the task board on the right.
    const columns = queryAll(query(m.container, '.lc-cols'), '.lc-col')
    assert.equal(columns.length, 2)
    assert.ok(columns[0].contains(query(m.container, '.lc-agents')), 'the network owns the left column')
    assert.ok(columns[1].contains(query(m.container, '.lc-members')), 'the members board heads the right column')
    assert.ok(columns[1].contains(query(m.container, '.lc-tasks')), 'the task board sits under it')
    // The lead badge lands on the member card.
    const leadCard = queryAll(m.container, '.lc-member-card')[0]
    assert.ok(text(leadCard).includes(DICT_EN['fleet.role.lead']))
    await m.unmount()
    ctx.dispose()
  })

  test('a team without a family forest serves the task board alone in the cockpit row', async () => {
    stubFleetRoute()
    // No sessions service: the forest derivation stays null, so the members board has no roster
    // to join — the viewed session's own projection still carries the team.
    const ctx = new TestClientCtx({ services: {} })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'root',
      useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM_PROJECTION }),
    }))
    const row = query(m.container, '.lc-cols')
    assert.ok(row !== null)
    assert.equal(queryAll(m.container, '.lc-agents').length, 0)
    assert.equal(queryAll(m.container, '.lc-members').length, 0)
    assert.equal(queryAll(m.container, '.lc-summary').length, 0, 'no strip without a family')
    const tasks = query(m.container, '.lc-tasks')
    assert.ok(tasks !== null)
    assert.ok(row.contains(tasks), 'the task board sits alone in the row')
    await m.unmount()
    ctx.dispose()
  })

  test('a solo session keeps the boards up with guidance — the graph, the strip, and pointers', async () => {
    stubFleetRoute()
    const snapshot = { byId: { only: { displayTitle: 'Solo', running: false, updatedAt: 1 } } }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'only', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(query(m.container, '.lc-agents') !== null)
    // The strip paints the stats but no progress bar.
    assert.ok(query(m.container, '.lc-summary') !== null)
    assert.equal(queryAll(m.container, '.lc-summary-progress').length, 0)
    // The boards stay up with guidance instead of vanishing.
    assert.ok(text(query(m.container, '.lc-members')).includes(DICT_EN['fleet.board.solo']))
    assert.ok(text(query(m.container, '.lc-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    assert.equal(queryAll(m.container, '.lc-comms').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a plain subagents session: the subagent progress bar and the no-team pointer', async () => {
    stubFleetRoute()
    const snapshot = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        w1: {
          parentId: 'root', origin: 'subagent', running: false, updatedAt: 8,
          projectionValues: { subagent: { mode: 'one-shot', label: 'worker-bee' }, subagentTiming: { settledMs: 42000, lastTurnCompleted: true } },
        },
        w2: {
          parentId: 'root', origin: 'subagent', running: true, updatedAt: 6,
          projectionValues: { subagent: { mode: 'continuable', label: 'side-quest' } },
        },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    // The strip's progress counts subagent completion (one of two settled).
    const progress = query(m.container, '.lc-summary-progress')
    assert.ok(text(progress).includes(DICT_EN['fleet.summary.subs']))
    assert.ok(text(progress).includes('1/2'))
    // No team: the members board lists the subagents, and the task board boards their delegations.
    assert.ok(text(query(m.container, '.lc-members')).includes(DICT_EN['fleet.board.noTeam']))
    assert.equal(queryAll(m.container, '.lc-member-card').length, 2)
    assert.ok(!text(query(m.container, '.lc-tasks')).includes(DICT_EN['fleet.tasks.noTeam']), 'delegations board, no pointer')
    assert.deepEqual(queryAll(m.container, '.lc-tasks .lc-team-task').length, 2)
    await m.unmount()
    ctx.dispose()
  })

  test('zh locale renders the panel chrome in Chinese', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ locale: 'zh', services: { sessions: familySessions() } })
    const View = makeFleetView(asClientCtx(ctx), makeKit('zh'), makeAgentHeads())
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.board.title']))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.members.title']))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.comms.title']))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.summary.tasks']))
    await m.unmount()
    ctx.dispose()
  })

  test("a task card's report-back: the excerpt boards first, then the full read replaces it", async () => {
    // Fresh session ids: the page-scope read ledger carries no settled line for them (it outlives
    // the mounts in this file), so this test's stub owns the full protocol.
    const team = {
      members: [
        { id: 'rq-root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'rq-w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      ],
      tasks: [
        { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/'], ready: false, writeScopeWarnings: [] },
      ],
    }
    const snapshot = {
      byId: {
        'rq-root': { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: team } },
        'rq-w1': {
          parentId: 'rq-root', origin: 'subagent', running: true, updatedAt: 8,
          projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' }, subagentTiming: { settledMs: 42000 } },
        },
      },
    }
    // The full read stays in flight until released, so the waiting state is observable.
    const fulls: Array<(value: unknown) => void> = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; full?: boolean }
      if (body.full === true) {
        return new Promise((resolve) => { fulls.push(resolve) })
      }
      const value = body.sessionId === 'rq-w1'
        ? { lastReply: { time: 1_700_000_000_000, text: '13 of 15 c…' }, messages: [], truncated: true }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'rq-root', useProjection: projectionsFor(richTimeline()) }))

    // The excerpt lands within the scan; opening the row asks for the owner's full read.
    await until(() => text(m.container).includes('13 of 15 c…'), 'the excerpt never landed')
    await click(query(m.container, '[data-task="task-1"]'))
    const card = queryAll(m.container, '[data-task="task-1"] .lc-ts-card').at(-1)!
    assert.ok(text(card).includes('13 of 15 c…'), 'the excerpt boards while waiting')
    assert.ok(text(card).includes(DICT_EN['fleet.tasks.replyFull']))
    assert.equal(fulls.length, 1, 'one whole-log read for the owner, not per render')

    fulls[0]!({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        value: { lastReply: { time: 1_700_000_000_000, text: '13 of 15 cases, fully reported.' }, messages: [], truncated: false },
      }),
    })
    await until(() => text(m.container).includes('13 of 15 cases, fully reported.'), 'the full read never replaced the excerpt')
    assert.ok(!text(m.container).includes(DICT_EN['fleet.tasks.replyFull']), 'the note yields once full')

    // A fold-back and re-unfold never re-ask: the ledger keyed once per session per mount.
    await click(query(m.container, '[data-task="task-1"]'))
    await click(query(m.container, '[data-task="task-1"]'))
    await until(() => fulls.length === 1 && text(m.container).includes('fully reported.'), 're-unfolding lost the full text')
    await m.unmount()
    ctx.dispose()
  })
})
