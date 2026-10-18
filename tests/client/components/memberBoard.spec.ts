// MemberBoard — every family agent in one panel: the team roster as full cards (identity, status,
// model, duty, latest reply, owner-filter interlock), the other agents as cards in the same form
// (label as the name, run meta in place of the duty line), and the toolbar (search / status / sort)
// steering both sections, down to the no-team and solo guidance.

import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { MemberBoard, type MemberBoardProps } from '../../../src/client/components/memberBoard'
import type { AgentForest, AgentNode } from '../../../src/client/agentTree'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import type { FleetDetail } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()

/** React's controlled input needs the native setter for the change to register. */
async function typeIn(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A controlled select flips through the same native-setter idiom. */
async function selectIn(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

const FOREST: AgentForest = {
  nodes: [
    nodeOf('root', { isCurrent: true, running: true, model: 'deepseek-v4' }),
    nodeOf('w1', { running: true }),
    nodeOf('w2'),
    nodeOf('s1', { label: 'scout', running: true, model: 'deepseek-flash', head: { tokens: 800, window: 1000, pct: 80, parts: [] }, requests: 5, durationMs: 42000, updatedAt: 8 }),
    nodeOf('s2', { label: 'archivist', completed: true, head: { tokens: 200, window: 1000, pct: 20, parts: [] }, requests: 1, durationMs: 9000, updatedAt: 6 }),
    nodeOf('s3', { label: 'lounger', updatedAt: 4 }),
  ],
  edges: [],
  overflow: 0,
  solo: false,
}

function teamOf(): FleetTeam {
  return {
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      { id: 'w2', name: 'flaky-one', role: 'teammate', phase: 'failed', error: 'provider blew up' },
      { id: 'w3', name: 'new-joiner', role: 'teammate', phase: 'provisioning' },
    ],
    tasks: [
      { id: 'task-1', subject: 'schema', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
      { id: 'task-2', subject: 'done work', description: '', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
    ],
  }
}

const LEAD_DETAIL: FleetDetail = {
  roster: [
    { name: 'worker-bee', description: '维度2：代码质量', provider: 'spawn', context: 'fresh' },
    { name: 'flaky-one', description: '维度3：稳定性' },
  ],
  messages: [],
  truncated: false,
}

function propsOf(over: Partial<MemberBoardProps> = {}): MemberBoardProps {
  return {
    team: teamOf(),
    forest: FOREST,
    leadDetail: LEAD_DETAIL,
    detailOf: () => undefined,
    pinnedId: null,
    onPin: () => {},
    onHover: () => {},
    onOpen: () => {},
    ownerFilter: null,
    onOwnerFilter: () => {},
    t: kit.t,
    fmt: kit.fmt,
    ...over,
  }
}

describe('MemberBoard — team cards', () => {
  test('cards render identity, status, duty, model, reply, and task counts', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { lastReply: { time: 100, text: 'schema parser landed' }, messages: [], truncated: false } }],
    ])
    const m = await mount(h(MemberBoard, propsOf({
      detailOf: id => details.get(id),
      pinnedId: 'w1',
    })))
    // Four roster cards, then the three other-agents cards in the same form.
    const cards = queryAll(m.container, '.lc-member-card')
    assert.equal(cards.length, 7)

    const lead = cards[0]
    assert.ok(text(lead).includes('lead'))
    assert.ok(text(lead).includes('current'))
    assert.ok(text(lead).includes('deepseek-v4'))
    assert.ok(text(lead).includes('running'))
    // The lead is the current session: no open button.
    assert.equal(queryAll(lead, '.lc-member-open').length, 0)

    const worker = cards[1]
    assert.ok(worker.className.includes('lc-member-pinned'))
    assert.ok(text(worker).includes('维度2：代码质量'))
    assert.ok(text(worker).includes('schema parser landed'))
    assert.ok(text(worker).includes('1 active tasks'))
    // The completed task does not count toward the active chip.

    const flaky = cards[2]
    assert.ok(flaky.className.includes('lc-member-failed'))
    assert.ok(text(flaky).includes('provider blew up'))

    const joiner = cards[3]
    assert.ok(text(joiner).includes('provisioning'))
    assert.ok(text(joiner).includes('no active tasks'))
    await m.unmount()
  })

  test('card click pins, task chip filters the board, open jumps', async () => {
    const pins = new Array<string | null>()
    const opened = new Array<string>()
    const hovers = new Array<string | null>()
    // The owner filter is a controlled prop: the wrapper plays the view, holding its state.
    let ownerFilter: string | null = null
    const filters = new Array<string | null>()
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        ownerFilter,
        onPin: id => { pins.push(id) },
        onOwnerFilter: (name) => {
          ownerFilter = name
          filters.push(name)
        },
        onOpen: id => { opened.push(id) },
        onHover: id => { hovers.push(id) },
      }))
    }
    const m = await mount(h(Controlled))
    const worker = queryAll(m.container, '.lc-member-card')[1]
    await hover(worker)
    await click(worker)
    await unhover(worker)
    assert.deepEqual([...pins], ['w1'])
    assert.deepEqual([...hovers], ['w1', null])

    // The task chip filters without disturbing the pin; a re-click clears (controlled state).
    await click(query(worker, '.lc-member-tasks'))
    assert.deepEqual([...pins], ['w1'])
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee'])
    assert.ok(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks').className.includes('lc-member-tasks-on'))
    await click(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks'))
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee', null])

    await click(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-open'))
    assert.deepEqual([...opened], ['w1'])
    assert.deepEqual([...pins], ['w1'], 'open never pins')
    await m.unmount()
  })

  test('picks report the card’s id; the parent owns the toggle', async () => {
    const pins = new Array<string>()
    // The parent-side toggle, emulated: a pick on the picked card releases, otherwise it pins.
    let pinned: string | null = 'w1'
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        pinnedId: pinned,
        onPin: (id) => {
          pins.push(id)
          pinned = pinned === id ? null : id
        },
      }))
    }
    const m = await mount(h(Controlled))
    const card = (): HTMLElement => queryAll(m.container, '.lc-member-card')[1]
    await click(card())
    await m.update(h(Controlled))
    await click(card())
    await m.update(h(Controlled))
    assert.deepEqual([...pins], ['w1', 'w1'])
    await m.unmount()
  })

  test('keyboard picks report the id; the failure badge and an empty roster render', async () => {
    const pins = new Array<string>()
    // The pin is a controlled prop: the wrapper plays the view, holding its state.
    let pinned: string | null = 'w1'
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        team: { ...teamOf(), failure: 'bad row' },
        pinnedId: pinned,
        onPin: (id) => {
          pins.push(id)
          pinned = pinned === id ? null : id
        },
      }))
    }
    const m = await mount(h(Controlled))
    assert.ok(text(m.container).includes(DICT_EN['fleet.team.failureShort']))
    // The card starts pinned (w1): Enter reports the pick (released), Space picks again.
    const card = (): HTMLElement => queryAll(m.container, '.lc-member-card')[1]
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })) })
    assert.deepEqual([...pins], ['w1', 'w1'])
    await m.unmount()
  })

  test('model falls back to the descriptor when the node lists none; a member outside the forest renders bare', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { descriptor: { mode: 'continuable', label: 'w', agentModel: 'flash-lite' }, messages: [], truncated: false } }],
    ])
    const forest: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], overflow: 0, solo: false }
    const m = await mount(h(MemberBoard, propsOf({
      forest,
      detailOf: id => details.get(id),
      leadDetail: null,
    })))
    const cards = queryAll(m.container, '.lc-member-card')
    // No roster facts: no duty descriptions; the descriptor model stands in.
    assert.ok(text(cards[1]).includes('flash-lite'))
    assert.equal(queryAll(cards[1], '.lc-member-desc').length, 0)
    // Members without a forest node get no open button.
    assert.equal(queryAll(m.container, '.lc-member-open').length, 0)
    await m.unmount()
  })
})

describe('MemberBoard — the other-agents cards', () => {
  /** The cards of the "other agents" section: the grid after that section's own head. */
  function otherCards(container: HTMLElement): HTMLElement[] {
    const head = queryAll(container, '.lc-board-section-head')
      .find(h => text(h).includes(DICT_EN['fleet.board.others']))
    return queryAll((head?.nextElementSibling ?? container) as HTMLElement, '.lc-member-card')
  }
  function otherNames(container: HTMLElement): string[] {
    return otherCards(container).map(c => text(query(c, '.lc-member-name')))
  }

  test('non-member family agents render as member cards with status, meta, and the open jump', async () => {
    const pins = new Array<string | null>()
    const opened: string[] = []
    const hovers: (string | null)[] = []
    // A landed detail fills the card's reply line, like the roster cards'.
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['s2', { detail: { lastReply: { time: 100, text: 'archive sealed' }, messages: [], truncated: false } }],
    ])
    const m = await mount(h(MemberBoard, propsOf({
      detailOf: id => details.get(id),
      onPin: id => { pins.push(id) },
      onOpen: id => { opened.push(id) },
      onHover: id => { hovers.push(id) },
    })))
    // The section head, then one card per plain subagent — the current session and team members stay out.
    assert.ok(text(m.container).includes(DICT_EN['fleet.board.others']))
    assert.deepEqual(otherNames(m.container), ['scout', 'archivist', 'lounger'])
    const cards = otherCards(m.container)
    // The run meta rides the card: consumption, duration, steps — no occupancy figure.
    assert.ok(text(cards[0]).includes('800 · 42s · 5 steps'))
    assert.ok(!text(cards[0]).includes('%'))
    assert.ok(text(cards[0]).includes('deepseek-flash'))
    assert.ok(text(cards[0]).includes('running'))
    assert.ok(text(cards[1]).includes('archive sealed'), 'the landed latest reply fills the card')
    // A stat-less agent carries no meta line and reads as inactive.
    assert.equal(queryAll(cards[2], '.lc-member-meta').length, 0)
    assert.ok(text(cards[2]).includes(DICT_EN['fleet.memberInactive']))

    await hover(cards[0])
    await click(cards[0])
    await unhover(cards[0])
    assert.deepEqual([...pins], ['s1'])
    assert.deepEqual(hovers, ['s1', null])
    await click(query(cards[0], '.lc-member-open'))
    assert.deepEqual(opened, ['s1'])
    assert.deepEqual([...pins], ['s1'], 'open never pins')

    // Keyboard: Enter pins, an unrelated key is inert.
    await act(async () => { cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await act(async () => { cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })) })
    assert.deepEqual([...pins], ['s1', 's1'])
    await m.unmount()

    // The pinned card rings; picks (click and Space) report the card's id — the parent toggles.
    const again = new Array<string>()
    const m2 = await mount(h(MemberBoard, propsOf({ pinnedId: 's1', onPin: id => { again.push(id) } })))
    const pinnedCard = otherCards(m2.container)[0]
    assert.ok(pinnedCard.className.includes('lc-member-pinned'))
    await click(pinnedCard)
    await act(async () => { pinnedCard.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    assert.deepEqual([...again], ['s1', 's1'])
    await m2.unmount()
  })

  test('the controlled hover lifts the matching card in either section', async () => {
    const m = await mount(h(MemberBoard, propsOf({ hoverId: 'w2' })))
    const cards = queryAll(m.container, '.lc-member-card')
    assert.equal(cards.filter(c => c.className.includes('lc-member-hover')).length, 1)
    assert.ok(cards[2].className.includes('lc-member-hover'), 'the roster card lifts')
    await m.update(h(MemberBoard, propsOf({ hoverId: 's1' })))
    assert.ok(otherCards(m.container)[0].className.includes('lc-member-hover'), 'the other-agents card lifts')
    assert.ok(!queryAll(m.container, '.lc-member-card')[2].className.includes('lc-member-hover'))
    await m.update(h(MemberBoard, propsOf({})))
    assert.equal(queryAll(m.container, '.lc-member-card').filter(c => c.className.includes('lc-member-hover')).length, 0)
    await m.unmount()
  })

  test('the toolbar searches, filters by status, and sorts — across both sections', async () => {
    const m = await mount(h(MemberBoard, propsOf()))
    // Status filter: running keeps the running members' cards and the running subagent's card.
    const filters = queryAll(m.container, '.lc-fleet-filters .lc-gran-btn')
    await click(filters[1])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['lead', 'worker-bee', 'scout'])
    await click(filters[2])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['archivist'])
    await click(filters[3])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['flaky-one', 'new-joiner', 'lounger'])
    await click(filters[0])

    // Sort by context tokens: 800 ahead of 200 ahead of the headless idler.
    await selectIn(query(m.container, '.lc-fleet-sort'), 'tokens')
    assert.deepEqual(otherNames(m.container), ['scout', 'archivist', 'lounger'])
    // (Spawn order coincides here; the reverse fixture order proves the sort.)
    await m.unmount()

    // A headless idler mid-list exercises the sorters' null-head arms on both sides.
    const flipped: AgentForest = { ...FOREST, nodes: [FOREST.nodes[0], FOREST.nodes[1], FOREST.nodes[2], FOREST.nodes[3], FOREST.nodes[5], FOREST.nodes[4]] }
    const m2 = await mount(h(MemberBoard, propsOf({ forest: flipped })))
    assert.deepEqual(otherNames(m2.container), ['scout', 'lounger', 'archivist'], 'spawn order follows the forest')
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'tokens')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'duration')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'steps')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'recent')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await m2.unmount()
  })

  test('search narrows both sections; a dead end names it', async () => {
    const m = await mount(h(MemberBoard, propsOf()))
    await typeIn(query(m.container, '.lc-fleet-search'), 'worker')
    assert.equal(queryAll(m.container, '.lc-member-card').length, 1)
    await typeIn(query(m.container, '.lc-fleet-search'), 'zzz-no-match')
    assert.equal(queryAll(m.container, '.lc-member-card').length, 0)
    assert.ok(text(m.container).includes(DICT_EN['fleet.list.empty']))
    await m.unmount()
  })
})

describe('MemberBoard — guidance states', () => {
  test('no team: the note names the mode and the family cards still list', async () => {
    const m = await mount(h(MemberBoard, propsOf({ team: null })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.board.noTeam']))
    // Without a roster every non-current node is an "other agent" — in the same card form.
    assert.deepEqual(
      queryAll(m.container, '.lc-member-card .lc-member-name').map(el => el.textContent),
      ['w1', 'w2', 'scout', 'archivist', 'lounger'],
    )
    await m.unmount()
  })

  test('solo without a team: the panel points at the subagent tool and skips the toolbar', async () => {
    const solo: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], overflow: 0, solo: true }
    const m = await mount(h(MemberBoard, propsOf({ team: null, forest: solo })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.board.solo']))
    assert.equal(queryAll(m.container, '.lc-fleet-toolbar').length, 0)
    assert.equal(queryAll(m.container, '.lc-member-card').length, 0)
    await m.unmount()
  })

  test('a one-member team over a solo forest skips the toolbar too', async () => {
    const solo: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], overflow: 0, solo: true }
    const team: FleetTeam = { members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }
    const m = await mount(h(MemberBoard, propsOf({ team, forest: solo })))
    assert.equal(queryAll(m.container, '.lc-member-card').length, 1, 'the lead card stands')
    assert.equal(queryAll(m.container, '.lc-fleet-toolbar').length, 0)
    await m.unmount()
  })

  test('a team whose members all filtered out hides the section but keeps the other cards', async () => {
    const m = await mount(h(MemberBoard, propsOf()))
    await typeIn(query(m.container, '.lc-fleet-search'), 'scout')
    assert.ok(text(m.container).includes('scout'))
    assert.equal(queryAll(m.container, '.lc-member-card').length, 1)
    await m.unmount()
  })
})
