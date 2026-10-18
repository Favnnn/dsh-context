// The sliced cold fold of the projection warm-up (src/host/backfill.ts, issue #145) over the
// REAL registry + the plugin's REAL units — byte-equality against one single-shot restore.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { watchActivityBackfill } from '../../src/host/backfill'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { createContextActivityDefinition } from '../../src/host/activity'
import { createContextHeadersDefinition } from '../../src/host/headers'
import { arm, captureLogs, connectionOf, fakeState, trigger, until } from './helpers/backfill'
import type { RouteBox } from './helpers/backfill'


/** A contiguous fake log of the given length (restore validates seq continuity, nothing else). */
function fakeEvents(length: number): SessionEvent[] {
  return Array.from({ length }, (_, seq) => ({ type: 'todo/write', seq, time: seq + 1, data: {} })) as unknown as SessionEvent[]
}

interface SliceRig {
  route: RouteBox
  writes: Map<string, unknown>
  prepares: string[]
  coldSnapshots: string[]
  restoreCalls: number[]
}

/** One single-shot restore over the same log on a fresh registry — the sliced path's reference answer. */
function referenceRows(events: SessionEvent[], id: string): unknown {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => true) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  return registry.restore({}, events, 0 as never, { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false } as never, 0 as never).checkpoint
}

/** Arm the backfill with the REAL registry + the plugin's REAL units, fake persistence serving
 * `events`, and the sliced path's faces (prepare/write) wired to the registry the way dsh's
 * SessionStore and SessionProjectionCache wire them. */
function armSliced(ctx: Context, eventsById: Map<string, SessionEvent[]>, opts: {
  liveOnPrepare?: Set<string>
  failPrepare?: Set<string>
  failWrite?: boolean
  noPrepare?: boolean
  hostileRestoreAt?: number
} = {}): SliceRig {
  const route: RouteBox = {}
  const state = fakeState([...eventsById.keys()].map(id => ({ header: { id, cwd: `/repo/${id}` } })))
  const rig: SliceRig = {
    route,
    writes: new Map(),
    prepares: [],
    coldSnapshots: state.coldSnapshots,
    restoreCalls: [],
  }
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => true) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  const realRestore = registry.restore.bind(registry)
  registry.restore = ((...args: Parameters<typeof realRestore>) => {
    rig.restoreCalls.push((args[1] as SessionEvent[]).length)
    if (opts.hostileRestoreAt !== undefined && rig.restoreCalls.length === opts.hostileRestoreAt) return undefined
    return realRestore(...args)
  }) as typeof registry.restore
  ctx.provide('connection', connectionOf(route))
  ctx.provide('sessionQuery', { listSessions: async () => state.listed })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => undefined,
    coldSnapshot: (header: { id: string }) => {
      state.coldSnapshots.push(header.id)
      return { asOfSeq: 0, values: {} }
    },
    write: async (session: { id: string }) => {
      if (opts.failWrite === true) throw new Error('disk full')
      rig.writes.set(session.id, registry.checkpoint(session as never))
    },
  })
  ctx.provide('sessionPersistence', {
    open: async (id: string) => {
      state.coldReads.push(id)
      return {
        header: { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: eventsById.get(id) ?? [] }),
        close: async () => {},
      }
    },
  })
  const threwPrepare = new Set<string>()
  const sessionsFace: Record<string, unknown> = {
    get: (id: string) => (state.live.has(id) || threwPrepare.has(id) ? { id } : undefined),
  }
  if (opts.noPrepare !== true) {
    sessionsFace.prepare = (id: string, o: { seed: SessionEvent[]; meta: unknown; inheritedEventCount: number }) => {
      rig.prepares.push(id)
      if (opts.liveOnPrepare?.has(id) === true) {
        threwPrepare.add(id)
        throw new Error(`session "${id}" already exists`)
      }
      if (opts.failPrepare?.has(id) === true) throw new Error(`session "${id}" has a corrupt header`)
      return {
        id,
        header: o.meta,
        inheritedEventCount: o.inheritedEventCount,
        seq: o.seed.length,
        snapshotEvents: () => o.seed,
      }
    }
  }
  ctx.provide('sessions', sessionsFace)
  return rig
}

describe('the sliced cold fold (issue #145)', () => {
  test('a monster session folds in slices and writes back rows byte-identical to one single-shot restore', async () => {
    const ctx = new Context()
    const events = fakeEvents(5_001) // three slices: 2000 + 2000 + 1001
    const rig = armSliced(ctx, new Map([['monster', events]]))
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(rig.coldSnapshots, [], 'the sliced path never calls coldSnapshot')
    assert.deepEqual(rig.prepares, ['monster'])
    assert.ok(rig.restoreCalls.length >= 3, `expected ≥3 sliced restores, got ${rig.restoreCalls.join(',')}`)
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows(events, 'monster'), 'sliced rows must equal the single-shot rows byte for byte')
  })

  test('a hostile restore answer (no checkpoint) refolds from init and still lands the exact rows', async () => {
    const ctx = new Context()
    const events = fakeEvents(4_001)
    const rig = armSliced(ctx, new Map([['monster', events]]), { hostileRestoreAt: 2 })
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows(events, 'monster'), 'a dropped slice answer degrades to a from-init refold — same rows')
  })

  test('a small session stays on the single-shot coldSnapshot path even when the slice faces exist', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['small', fakeEvents(2_000)]]))
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.coldSnapshots.length === 1 ? true : undefined), 'the coldSnapshot ran')
    dispose()
    assert.deepEqual(rig.coldSnapshots, ['small'])
    assert.deepEqual(rig.prepares, [], 'no prepare for a session at or under the slice threshold')
    assert.deepEqual([...rig.writes.keys()], [])
  })

  test('missing slice faces fall back to coldSnapshot for the same monster session', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(4_001)]], ), { noPrepare: true })
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.coldSnapshots.length === 1 ? true : undefined), 'the fallback ran')
    dispose()
    assert.deepEqual(rig.coldSnapshots, ['monster'], 'no prepare face → single-shot path')
    assert.deepEqual([...rig.writes.keys()], [])
  })

  test('a session going live mid-fold is skipped silently (no write, no warn)', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['racer', fakeEvents(4_001)]]), { liveOnPrepare: new Set(['racer']) })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await new Promise(resolve => setTimeout(resolve, 250))
    dispose()
    assert.deepEqual(rig.prepares, ['racer'])
    assert.deepEqual([...rig.writes.keys()], [], 'no write over a session that went live')
    assert.deepEqual(lines.filter(l => l.level === 'warn'), [], 'a live race never warns')
  })

  test('a prepare failure with the session still cold warns and the run continues', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['broken', fakeEvents(4_001)], ['good', fakeEvents(10)]]), { failPrepare: new Set(['broken']) })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.coldSnapshots.length === 1 ? true : undefined), 'the small session folded')
    await new Promise(resolve => setTimeout(resolve, 250))
    dispose()
    assert.deepEqual([...rig.writes.keys()], [])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1, 'the genuine prepare failure keeps the per-session warn')
    assert.match(warns[0].text, /"broken"/)
    assert.match(warns[0].text, /corrupt header/)
    assert.deepEqual(rig.coldSnapshots, ['good'], 'the next session still folds')
  })

  test('a rejecting write-back warns (fail-soft) and the session still counts as folded', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(4_001)]]), { failWrite: true })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (lines.some(l => l.text.includes('write-back')) ? true : undefined), 'the write-back warning')
    await new Promise(resolve => setTimeout(resolve, 250))
    dispose()
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0].text, /write-back for "monster" failed/)
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('backfilled for 1 session(s)')), 'the fold itself succeeded')
  })

  test('dispose mid-fold aborts between slices: no write, no completion line', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(6_001)]]) )
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.restoreCalls.length >= 1 ? true : undefined), 'the first slice folded')
    dispose()
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual([...rig.writes.keys()], [], 'nothing durable lands mid-fold')
    assert.deepEqual(lines.filter(l => l.level === 'info' && l.text.includes('backfilled')), [], 'the pass stopped quietly')
  })

  test('pacing rests proportionally to measured work and takes a logged recovery pause at the round budget', async () => {
    const ctx = new Context()
    const state = fakeState([1, 2, 3, 4].map(i => ({ header: { id: `s${i}`, cwd: `/repo/s${i}` } })))
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400), // every session measures 400ms of work
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 1_000,
      roundPauseMs: 1_000,
    })
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 4 ? true : undefined), 'all four sessions folded')
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldSnapshots.sort(), ['s1', 's2', 's3', 's4'])
    // Rests follow the measured 400ms cost; the third rest trips the 1000ms budget into a full pause.
    assert.deepEqual(sleeps, [400, 400, 1_000, 400])
    const pauses = lines.filter(l => l.level === 'info' && l.text.includes('pausing after'))
    assert.equal(pauses.length, 1, 'the budget pause reports once')
    assert.match(pauses[0].text, /pausing after 1s of fold work; resuming in 1s/)
  })

  test('sliced folds rest proportionally between slices, billed once across both granularities', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(4_001)]]) )
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    // Two inter-slice rests (3 slices, 400ms per injected clock jump); the session-level rest
    // covers only the non-sliced remainder (whole session 2800ms minus the 1200ms of slice work).
    assert.deepEqual(sleeps, [400, 400, 1_600])
  })

  test('a zero-cost session rests exactly the floor', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const route = arm(ctx, state)
    const sleeps: number[] = []
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 2 ? true : undefined), 'both sessions folded')
    dispose()
    assert.deepEqual(sleeps, [25, 25])
  })

  test('dispose wakes a pending rest early (the pass never waits out a pause)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const route = arm(ctx, state)
    let sleeping = false
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => 0,
      sleep: async () => { sleeping = true; await new Promise(() => {}) }, // never resolves on its own
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(route)
    await until(() => (sleeping ? true : undefined), 'the first rest is pending')
    dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(state.coldSnapshots, ['a'], 'the abort woke the pending rest; the pass stopped without hanging')
  })

  test('a rest armed after dispose returns at once', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const route = arm(ctx, state)
    let dispose: () => void = () => {}
    let folds = 0
    const gate = {
      admit: <T>(read: () => Promise<T>): Promise<T | undefined> => {
        const p = read()
        folds++
        if (folds === 2) dispose() // the second session's fold completes with the pass already disposed
        return p
      },
    }
    const sleeps: number[] = []
    dispose = watchActivityBackfill(ctx, gate, {
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 2 ? true : undefined), 'both sessions folded')
    await new Promise(resolve => setTimeout(resolve, 30))
    // The post-dispose session-level rest skipped its sleep entirely, so only the first rest slept.
    assert.deepEqual(sleeps, [25])
  })

  test('a budget trip inside one monster session pauses mid-fold and still completes the exact rows', async () => {
    const ctx = new Context()
    const events = fakeEvents(4_001)
    const rig = armSliced(ctx, new Map([['monster', events]]))
    const lines = captureLogs(ctx)
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 800,
      roundPauseMs: 2_000,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    // Slice 1 rests 400; slice 2's rest trips the 800ms budget into a 2000ms pause; the
    // session-level remainder (1600) trips it again. The pass resumes after each pause.
    assert.deepEqual(sleeps, [400, 2_000, 2_000])
    const pauses = lines.filter(l => l.level === 'info' && l.text.includes('pausing after'))
    assert.equal(pauses.length, 2)
    assert.match(pauses[0].text, /pausing after 1s of fold work; resuming in 2s/)
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows(events, 'monster'), 'pauses never change the rows')
  })
})
