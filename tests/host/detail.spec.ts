// The on-demand detail route (src/host/detail.ts) and its gate: the nested-inject gating on the connection/sessions faces (load-order
// independent), the live flip on unload, and typed outcomes — never a throw into the transport.

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DETAIL_ROUTE, watchDetailChannel } from '../../src/host/detail'
import { resolveBounds } from '../../src/host/config'
import type { TimelineState } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/foldWire'
import type { TimelineEvent } from '../../src/host/foldState'
import { assistantMessage, header, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const BOUNDS = resolveBounds({})

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessions?: unknown
  sessionQuery?: unknown
  sessionPersistence?: unknown
  stateOf?: (session: unknown, key: string) => unknown
}

/** A minimal host ctx double with cordis inject semantics: the callback runs
 * once its dependency list completes (here: immediately when the services
 * map has them, never otherwise), and its returned disposer is collected. */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessions' in spec) services.set('sessions', spec.sessions)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  if ('sessionPersistence' in spec) services.set('sessionPersistence', spec.sessionPersistence)
  const ctx = {
    get: (name: string) => services.get(name),
    sessionProjections: { stateOf: spec.stateOf ?? (() => undefined) },
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  // Wire the connection face so register() captures its route.
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { fetch?: { register?: unknown } }
    if (typeof conn.fetch?.register === 'function') {
      conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
        captured.path = route.path
        captured.fetch = route.fetch
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

async function call(captured: { fetch?: RouteFetch }, body: unknown): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

async function callRaw(captured: { fetch?: RouteFetch }, body: string): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return await captured.fetch!(request).then(r => r.json()) as Record<string, unknown>
}

function sessionsWith(session: unknown): { get(id: string): unknown } {
  return { get: (id: string) => (id === 's1' ? session : undefined) }
}

function okSession(): object {
  return { id: 's1' }
}

describe('watchDetailChannel gating', () => {
  test('the gate stays closed without the connection or sessions service', () => {
    assert.equal(watchDetailChannel(ctxOf({}).ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({ sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    const connOnly = ctxOf({ connection: { fetch: { register: () => () => {} } } })
    assert.equal(watchDetailChannel(connOnly.ctx, BOUNDS).live, false)
    // A connection without the fetch.register face, or a sessions without get.
    assert.equal(watchDetailChannel(ctxOf({ connection: { fetch: {} }, sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: { get: 42 },
    }).ctx, BOUNDS).live, false)
  })

  test('the gate opens on registration and closes on unload', () => {
    const { ctx, captured, disposers } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
    })
    const gate = watchDetailChannel(ctx, BOUNDS)
    assert.equal(gate.live, true)
    assert.equal(captured.path, '/api/dsh-context/detail')
    assert.equal(typeof captured.fetch, 'function')
    // Unload: the inject fiber's disposer closes the gate (the wire flips back to inline).
    for (const d of disposers) d()
    assert.equal(gate.live, false)
  })

  test('a rejecting registry keeps the gate closed without throwing', () => {
    const ctx = {
      get: (name: string) =>
        name === 'connection'
          ? {
            fetch: {
              register: () => {
                throw new Error('registration rejected')
              },
            },
          }
          : name === 'sessions'
            ? sessionsWith(okSession())
            : undefined,
      sessionProjections: { stateOf: () => undefined },
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => (d === 'connection' || d === 'sessions'))) cb(ctx)
      },
    }
    assert.equal(watchDetailChannel(ctx as unknown as Context, BOUNDS).live, false)
  })
})

describe('the detail route', () => {
  function liveCtx(state: TimelineState | undefined): { ctx: Context; captured: { fetch?: RouteFetch } } {
    return ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => state,
    })
  }

  test('bad payloads fail with typed envelopes', async () => {
    const { ctx, captured } = liveCtx(undefined)
    watchDetailChannel(ctx, BOUNDS)
    for (const body of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await call(captured, body) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(body)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
    // A non-JSON body degrades to the same typed rejection.
    const raw = await callRaw(captured, 'not json') as { ok: boolean; error?: { code: string } }
    assert.equal(raw.ok, false)
    assert.equal(raw.error?.code, 'dsh-context/bad-request')
  })

  test('a session outside the live set resolves to the typed null', async () => {
    const { state } = driveTimeline([userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 'gone' }), { ok: true, value: null })
  })

  test('an absent unit state resolves to the typed null', async () => {
    const { ctx, captured } = liveCtx(undefined)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a cold session (never entered into the live store) folds its detail off the observed log', async () => {
    const events = [
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
    ]
    let disposed = 0
    let observedOptions: unknown
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: (id: string, opts: unknown) => {
          observedOptions = opts
          return Promise.resolve(id === 'cold1'
            ? { events, [Symbol.dispose]: () => { disposed++ } }
            : null)
        },
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 'cold1' }) as {
      ok: boolean
      value: { rev: number; requests: unknown[]; nodes: unknown[]; head: { current: { total: number } } } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null)
    assert.equal(result.value.requests.length, 1, 'the observed log folded')
    assert.equal(result.value.nodes.length, 2)
    assert.ok(result.value.head.current.total > 0, 'the slim head rides the cold fold (the graph ring fetch)')
    assert.deepEqual(observedOptions, { projectionMode: 'none' }, 'the observation skips projection work')
    assert.equal(disposed, 1, 'the observation lease disposed after the fold')
    // A session nothing can observe (the query resolves null) stays a typed null.
    assert.deepEqual(await call(captured, { sessionId: 'nobody' }), { ok: true, value: null })
  })

  test('an observation without a dispose face still serves (nothing to release)', async () => {
    const events = [userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })]
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: () => Promise.resolve({ events }),
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 'cold1' }) as { ok: boolean; value: { nodes: unknown[] } | null }
    assert.equal(result.ok, true)
    assert.equal(result.value?.nodes.length, 1)
  })

  test('a sessionQuery without the observe face (or a rejecting read) degrades cleanly', async () => {
    // Face present but the method missing.
    const noFace = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {},
    })
    watchDetailChannel(noFace.ctx, BOUNDS)
    assert.deepEqual(await call(noFace.captured, { sessionId: 'cold' }), { ok: true, value: null })

    // The observation read rejects (persistence down).
    const rejecting = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {
        observeSession: () => Promise.reject(new Error('persistence down')),
      },
    })
    watchDetailChannel(rejecting.ctx, BOUNDS)
    const result = await call(rejecting.captured, { sessionId: 'cold' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'gateway/internal')
    assert.equal(result.error.message, 'persistence down')
  })

  test('a cold read skipped under heap pressure answers the typed null (and never observes)', async () => {
    let observed = 0
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: () => {
          observed++
          return Promise.resolve({ events: [] })
        },
      },
    })
    let admitted = 0
    watchDetailChannel(ctx, BOUNDS, {
      admit: <T>(_read: () => Promise<T>): Promise<T | undefined> => {
        admitted++
        return Promise.resolve(undefined)
      },
    })
    assert.deepEqual(await call(captured, { sessionId: 'cold1' }), { ok: true, value: null })
    assert.equal(admitted, 1, 'the cold read went through the gate')
    assert.equal(observed, 0, 'a skipped read never touches the log')
  })

  test('the live path never touches the cold-read gate', async () => {
    const { state } = driveTimeline([userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS, {
      admit: () => Promise.reject(new Error('the gate must not see a live read')),
    })
    const result = await call(captured, { sessionId: 's1' }) as { ok: boolean; value: { rev: number } | null }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null, 'the live read served its detail without the gate')
  })

  test('serves the fold state\'s detail payload with its revision', async () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
    ])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: true; value: { rev: number; requests: unknown[]; nodes: unknown[]; head: { current: { total: number } } } }
    assert.equal(result.ok, true)
    assert.equal(result.value.rev, 2, 'two detail-mutating folds')
    assert.equal(result.value.requests.length, 1)
    assert.equal(result.value.nodes.length, 2)
    assert.ok(result.value.head.current.total > 0, 'the slim head rides the live read too')
  })

  test('hostile reads degrade to the failure envelope, never a throw', async () => {
    // sessions.get throwing.
    const throwingGet = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw new Error('hostile sessions')
        },
      },
    })
    watchDetailChannel(throwingGet.ctx, BOUNDS)
    const r1 = await call(throwingGet.captured, { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(r1.ok, false)
    assert.equal(r1.error.code, 'gateway/internal')
    assert.equal(r1.error.message, 'hostile sessions')

    // stateOf throwing.
    const throwingState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => {
        throw new Error('hostile registry')
      },
    })
    watchDetailChannel(throwingState.ctx, BOUNDS)
    const r2 = await call(throwingState.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r2.ok, false)
    assert.equal(r2.error.message, 'hostile registry')

    // A state whose collections are junk (the detail builder throws).
    const junkState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => ({ requests: null }),
    })
    watchDetailChannel(junkState.ctx, BOUNDS)
    const r3 = await call(junkState.captured, { sessionId: 's1' }) as { ok: boolean }
    assert.equal(r3.ok, false)

    // A non-Error rejection stringifies into the envelope.
    const stringThrow = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw 'string boom'
        },
      },
    })
    watchDetailChannel(stringThrow.ctx, BOUNDS)
    const r4 = await call(stringThrow.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r4.ok, false)
    assert.equal(r4.error.message, 'string boom')
  })
})

describe('the cold fold (issue #145)', () => {
  function coldCtx(observe: (id: string) => Promise<unknown>, persistence: unknown = { backend: 'default' }): { ctx: Context; captured: { fetch?: RouteFetch } } {
    return ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: (id: string) => observe(id) },
      sessionPersistence: persistence,
    })
  }

  function manyEvents(count: number): TimelineEvent[] {
    const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
    for (let seq = 2; seq <= count; seq++) {
      events.push(seq % 2 === 0
        ? userMessage(seq, [{ type: 'text', text: `question ${seq}` }], { kind: 'user' })
        : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
    }
    return events
  }

  test('a monster log folds to the byte-identical detail, yielding to the event loop per chunk', async () => {
    const events = manyEvents(2_001)
    const { ctx, captured } = coldCtx(() => Promise.resolve({ events, [Symbol.dispose]: () => {} }))
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      watchDetailChannel(ctx, BOUNDS)
      const result = await call(captured, { sessionId: 'cold1' }) as { ok: boolean; value: unknown }
      assert.equal(result.ok, true)
      const reference = buildTimelineDetail(driveTimeline(events).state, BOUNDS)
      assert.deepStrictEqual(result.value, reference, 'the yielding fold produces the identical payload')
      const yields = timerSpy.mock.calls.filter(args => args[1] === 0).length
      assert.equal(yields, 2, 'two macrotask yields across 2,001 events')
    } finally {
      timerSpy.mockRestore()
    }
  })

  test('an unchanged log (same durable revision) re-serves the payload without refolding', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    let disposed = 0
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      revision: 'dev:ino:100:42:42',
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => { disposed++ },
    }))
    watchDetailChannel(ctx, BOUNDS)
    const first = await call(captured, { sessionId: 'cold1' })
    const second = await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 1, 'the second read never touched the log')
    assert.deepEqual(second, first, 'the re-served payload is identical')
    assert.equal(disposed, 2, 'both observation leases released')
  })

  test('a changed revision refolds (no stale payload, ever)', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    let revision = 'r1'
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      get revision() { return revision },
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    revision = 'r2' // the log moved: a new durable revision must fold again
    await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 2, 'the changed log refolded instead of serving stale data')
  })

  test('an observation without a revision (a live-race cut) never keys the cache', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 2, 'no revision — every read folds, as before')
  })

  test('the cache holds four sessions; the evicted oldest refolds, the kept newest re-serves', async () => {
    const reads = new Map<string, number>()
    const { ctx, captured } = coldCtx((id) => Promise.resolve({
      revision: `r-${id}`,
      get events() {
        reads.set(id, (reads.get(id) ?? 0) + 1)
        return manyEvents(5)
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) await call(captured, { sessionId: id })
    assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1], 'every first read folded')
    await call(captured, { sessionId: 'c5' })
    assert.equal(reads.get('c5'), 1, 'the newest entry survived eviction')
    await call(captured, { sessionId: 'c1' })
    assert.equal(reads.get('c1'), 2, 'the evicted oldest refolded on its next read')
  })

  test('a swapped persistence instance can never alias a stale payload (the dsh trust tuple)', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    const observe = (): Promise<unknown> => Promise.resolve({
      revision: 'same-token-from-two-backends',
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    })
    const first = coldCtx(observe, { backend: 'one' })
    watchDetailChannel(first.ctx, BOUNDS)
    await call(first.captured, { sessionId: 'cold1' })
    // The storage backend was replaced (its revision tokens say nothing anymore): refold.
    const second = coldCtx(observe, { backend: 'two' })
    watchDetailChannel(second.ctx, BOUNDS)
    await call(second.captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 2, 'a replaced persistence invalidates every cached payload')
  })

  test('a remount (a fresh watch closure) starts with an empty cache', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      revision: 'r1',
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    // The second watch (the config remount's re-arm) shares nothing with the first.
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 2, 'the remounted route folds against its own cache')
  })
})
