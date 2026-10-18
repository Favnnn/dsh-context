// fleetModel.ts — the shared family model seat and the fleet-detail read ledger.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import {
  commsStaleOf,
  teamOfSnapshot,
  useFleetDetails,
  useFleetModel,
  type FleetDetailState,
  type FleetModel,
} from '../../src/client/fleetModel'
import { FleetDetailCache } from '../../src/client/fleetDetail'
import type { AgentNode } from '../../src/client/agentTree'
import type { FleetDetail } from '../../src/shared/types'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { flush, mount } from './helpers/kit'
import { makeAgentHeads } from '../../src/client/agentHeads'

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

describe('teamOfSnapshot', () => {
  const team = { members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }

  test('the first carrying family row wins — DFS pre-order starts at the root', () => {
    const forest = { nodes: [nodeOf('root'), nodeOf('kid', { parentId: 'root' })], edges: [], overflow: 0, solo: false }
    const snapshot = {
      byId: {
        kid: { projectionValues: { agentTeam: { members: [{ id: 'kid', name: 'k', role: 'lead', phase: 'active' }], tasks: [] } } },
        root: { projectionValues: { agentTeam: team } },
      },
    }
    assert.equal(teamOfSnapshot(snapshot, forest)?.members[0]?.id, 'root')
  })

  test('degrades: no forest, no byId, no carrier row, or a malformed value', () => {
    const forest = { nodes: [nodeOf('root')], edges: [], overflow: 0, solo: true }
    assert.equal(teamOfSnapshot(null, forest), null)
    assert.equal(teamOfSnapshot({}, forest), null)
    assert.equal(teamOfSnapshot({ byId: null }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: {} } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: { projectionValues: { agentTeam: 'junk' } } } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: null } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: { projectionValues: { agentTeam: team } } } }, null), null)
  })
})

describe('commsStaleOf', () => {
  test('a landed read behind the row stamp is stale', () => {
    const landed = new Map<string, { detail: FleetDetail | null; updatedAt: number }>([
      ['a', { detail: null, updatedAt: 5 }],
    ])
    assert.equal(commsStaleOf([nodeOf('a', { updatedAt: 6 })], landed), true)
    assert.equal(commsStaleOf([nodeOf('a', { updatedAt: 5 })], landed), false)
    assert.equal(commsStaleOf([nodeOf('b', { updatedAt: 99 })], landed), false)
    assert.equal(commsStaleOf([], landed), false)
  })
})

/** A probe component exposing the hook's value to the test. */
describe('useFleetModel', () => {
  function sessionsFace(byId: Record<string, unknown>, refreshed: string[]) {
    // The snapshot object must stay reference-stable across reads: useSyncExternalStore loops on a fresh one.
    const snapshot = { byId }
    return {
      list: {
        getSnapshot: (): unknown => snapshot,
        subscribe: (): (() => void) => () => {},
      },
      refreshSubagents: (id: string) => {
        refreshed.push(id)
        return Promise.resolve()
      },
    }
  }

  test('inactive stays inert: no snapshot read, no refresh, no forest', async () => {
    const refreshed: string[] = []
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace({ s1: { running: true, updatedAt: 1 } }, refreshed) } })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, false)
      return null
    }
    const m = await mount(h(Probe))
    assert.equal(box.current?.forest, null)
    assert.equal(box.current?.team, null)
    assert.deepEqual(refreshed, [])
    await m.unmount()
    ctx.dispose()
  })

  test('active derives the forest and the team, and discovers the child catalog', async () => {
    const refreshed: string[] = []
    const byId = {
      s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
      kid: {
        parentId: 's1', origin: 'subagent', running: true, updatedAt: 2,
        projectionValues: { agentTeam: { members: [{ id: 's1', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, refreshed) } })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    assert.equal(box.current?.forest?.nodes.length, 2)
    assert.equal(box.current?.team?.members[0]?.name, 'lead')
    assert.deepEqual(refreshed, ['s1'])
    await m.unmount()
    ctx.dispose()
  })

  test('a rejecting catalog refresh is swallowed', async () => {
    const snapshot = { byId: { s1: { running: true, updatedAt: 1 } } }
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
          refreshSubagents: () => Promise.reject(new Error('nope')),
        },
      },
    })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    assert.ok(box.current?.forest !== null)
    await flush()
    await m.unmount()
    ctx.dispose()
  })
})

describe('useFleetDetails', () => {
  function probeDetails(cache: FleetDetailCache): { box: { current: FleetDetailState | null }; Probe: () => null } {
    const box: { current: FleetDetailState | null } = { current: null }
    function Probe(): null {
      box.current = useFleetDetails(cache)
      return null
    }
    return { box, Probe }
  }

  function detailCache(serve: (id: string) => FleetDetail | null): FleetDetailCache {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((id: string) => Promise.resolve(serve(id)))
    return cache
  }

  test('request lands the detail, dedupes by stamp, and pending drains', async () => {
    const cache = detailCache(id => ({ messages: [], truncated: false, initialPrompt: `prompt of ${id}` }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.request('a', 1) })
    assert.equal(box.current?.pending.has('a'), true)
    await act(async () => {})
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.get('a')?.detail?.initialPrompt, 'prompt of a')

    // Same or older stamp: no new read.
    act(() => { state.request('a', 1) })
    assert.equal(box.current?.pending.size, 0)
    // A newer stamp refetches.
    act(() => { state.request('a', 2) })
    await act(async () => {})
    assert.equal(box.current?.landed.get('a')?.updatedAt, 2)
    await m.unmount()
  })

  test('two in-flight reads for one session settle into one pending drain', async () => {
    const cache = new FleetDetailCache()
    const releases: Array<(d: FleetDetail | null) => void> = []
    vi.spyOn(cache, 'fetch').mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    // A fresher stamp mid-flight re-reads but never double-marks pending.
    act(() => { state.request('a', 1) })
    act(() => { state.request('a', 2) })
    assert.equal(box.current?.pending.size, 1)
    // The older read lands first: pending drains (the newer read is untracked by design — its
    // landing settles the ledger line), then the newer read's landing takes the newer stamp.
    await act(async () => { releases[0](null) })
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.get('a')?.updatedAt, 1)
    await act(async () => { releases[1]({ messages: [], truncated: false }) })
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.get('a')?.updatedAt, 2)
    await m.unmount()
  })

  test('scan requests every node; refresh re-reads them', async () => {
    let reads = 0
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation(() => {
      reads += 1
      return Promise.resolve(null)
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    const nodes = [nodeOf('a', { updatedAt: 1 }), nodeOf('b', { updatedAt: 1 })]

    act(() => { state.scan(nodes) })
    await act(async () => {})
    assert.equal(reads, 2)
    assert.equal(box.current?.landed.size, 2)

    act(() => { box.current?.refresh(nodes) })
    await act(async () => {})
    assert.equal(reads >= 3, true)
    await m.unmount()
  })

  test('a landing after unmount updates nothing', async () => {
    const cache = new FleetDetailCache()
    let release: (d: FleetDetail | null) => void = () => {}
    vi.spyOn(cache, 'fetch').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.request('a', 1) })
    await m.unmount()
    release(null)
    await flush()
    assert.equal(box.current?.landed.size, 0)
  })

  test('a full landing after unmount updates nothing', async () => {
    const cache = new FleetDetailCache()
    let release: (d: FleetDetail | null) => void = () => {}
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, full?: boolean) => {
      if (full !== true) return Promise.resolve(null)
      return new Promise((resolve) => { release = resolve })
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.requestFull('a') })
    await m.unmount()
    release({ messages: [], truncated: false, lastReply: { time: 1, text: 'late' } })
    await flush()
    assert.equal(box.current?.fullLanded.size, 0)
  })

  test('requestFull reads the full ledger once per session and lands fullLanded', async () => {
    let fullReads = 0
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, full?: boolean) => {
      if (full === true) {
        fullReads += 1
        return Promise.resolve({ messages: [], truncated: false, lastReply: { time: 1, text: 'FULL' } })
      }
      return Promise.resolve(null)
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.requestFull('a') })
    assert.equal(box.current?.fullPending.has('a'), true)
    // A second ask is deduped to the same single read.
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.equal(fullReads, 1)
    assert.equal(box.current?.fullPending.size, 0)
    assert.equal(box.current?.fullLanded.get('a')?.lastReply?.text, 'FULL')
    assert.equal(box.current?.landed.size, 0, 'the excerpt ledger stays untouched')
    await m.unmount()
  })

  test('a read serving nothing lands null once and never re-reads', async () => {
    let fullReads = 0
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, full?: boolean) => {
      if (full !== true) return Promise.resolve(null)
      fullReads += 1
      // A transport failure settles as null inside the cache (its own catch); the hook's
      // contract is a total promise.
      return Promise.resolve(null)
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.equal(box.current?.fullLanded.get('a') ?? null, null, 'the absence path lands as null')
    assert.equal(box.current?.fullPending.size, 0)
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.equal(fullReads, 1, 'a settled ask is deduped even when it read nothing')
    await m.unmount()
  })

  test('a later full landing replaces the first; the pending set drains exactly once', async () => {
    const releases: Array<(d: FleetDetail | null) => void> = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, full?: boolean) => {
      if (full !== true) return Promise.resolve(null)
      return new Promise((resolve) => { releases.push(resolve) })
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    // The excerpt arms the stamp the full read rides; the fold's read spells from it.
    act(() => { state.request('a', 5) })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    // A refresh released the ledger line mid-flight; the next unfold asks again — two reads
    // in flight, one pending mark.
    act(() => { state.refresh([nodeOf('a', { updatedAt: 5 })]) })
    act(() => { state.requestFull('a') })
    assert.equal(releases.length, 2)
    assert.equal(box.current?.fullPending.size, 1)

    // Both flights settle on the SAME value (a cache-hit replay): the first landing writes the
    // map; the second's identity bail-out writes nothing new.
    const landed: FleetDetail = { messages: [], truncated: false, lastReply: { time: 1, text: 'first' } }
    await act(async () => { releases[0]!(landed) })
    assert.equal(box.current?.fullLanded.get('a')?.lastReply?.text, 'first')
    assert.equal(box.current?.fullPending.size, 0, 'the first landing drains the set')
    await act(async () => { releases[1]!(landed) })
    assert.equal(box.current?.fullLanded.get('a')?.lastReply?.text, 'first')
    assert.equal(box.current?.fullPending.size, 0)
    await m.unmount()
  })

  test('refresh drops both ledgers', async () => {
    const cache = new FleetDetailCache()
    const invalidated: string[] = []
    vi.spyOn(cache, 'invalidate').mockImplementation(id => { invalidated.push(id) })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.requestFull('a') })
    act(() => { state.refresh([nodeOf('a', { updatedAt: 1 })]) })
    assert.deepEqual(invalidated, ['a'])
    await m.unmount()
  })
})
