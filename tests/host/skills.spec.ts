// The skill-catalog route (src/host/skills.ts): deferred-inject gating on the connection face, the session-addressed resolution mirroring
// the harness's own skill catalog (observeSession → cwd + preset; a live agent's scoped registry wins; a cold session rides a scope lease;
// every gap falls back to the global layers), and the typed `null` for every unusable face — never a throw into the transport.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SKILLS_ROUTE, watchSkillCatalog } from '../../src/host/skills'

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  skills?: unknown
  sessionQuery?: unknown
  agents?: unknown
  agentPresets?: unknown
}

/** A minimal host ctx double with cordis inject semantics (mirrors
 * balance.spec.ts's): the callback runs once its dependency list completes, and `ctx.get` serves the request-time reads. */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch } } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const services = new Map<string, unknown>()
  for (const key of ['connection', 'skills', 'sessionQuery', 'agents', 'agentPresets'] as const) {
    if (key in spec) services.set(key, spec[key])
  }
  const ctx = {
    get: (name: string) => services.get(name),
    effect(fn: () => unknown) {
      fn()
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      cb(ctx)
    },
  }
  const conn = spec.connection as { fetch?: { register?: unknown } } | undefined
  if (typeof conn?.fetch?.register === 'function') {
    const original = conn.fetch.register as (route: { path: string; fetch: RouteFetch }) => (() => void)
    conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
      const dispose = original(route)
      captured.path = route.path
      captured.fetch = route.fetch
      return dispose
    }
  }
  return { ctx: ctx as unknown as Context, captured }
}

const CONNECTION = { fetch: { register: () => () => {} } }

function registryOf(rows: unknown, log?: unknown[]): { list: (options: unknown) => Promise<unknown> } {
  return {
    list: async (options: unknown) => {
      log?.push(options)
      if (rows instanceof Error) throw rows
      return rows
    },
  }
}

function queryOf(observation: unknown, opts: { throws?: boolean; disposed?: string[] } = {}): { observeSession: (id: string) => Promise<unknown> } {
  return {
    observeSession: async () => {
      if (opts.throws === true) throw new Error('no such session')
      const obs = observation as Record<string, unknown>
      if (obs !== null && typeof obs === 'object' && opts.disposed !== undefined && !(Symbol.dispose in obs)) {
        (obs as unknown as Record<symbol, unknown>)[Symbol.dispose] = () => { opts.disposed?.push('disposed') }
      }
      return observation
    },
  }
}

const ROWS = [
  { name: 'tdd', description: 'Test-driven development', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents', invocation: {}, provider: 'fs' },
  { name: 'ask-matt', description: 'A router', source: 'project-agents' },
]

async function serve(captured: { fetch?: RouteFetch }, body: unknown = {}): Promise<Record<string, unknown>> {
  const response = await captured.fetch!(new Request('http://localhost' + SKILLS_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return await response.json() as Record<string, unknown>
}

function armed(spec: Omit<CtxSpec, 'connection'>): { path?: string; fetch?: RouteFetch } {
  const { ctx, captured } = ctxOf({ connection: CONNECTION, ...spec })
  watchSkillCatalog(ctx)
  return captured
}

describe('skills route registration', () => {
  test('no connection service never registers the route', () => {
    const { ctx, captured } = ctxOf({ skills: registryOf(ROWS) })
    watchSkillCatalog(ctx)
    assert.equal(captured.fetch, undefined)
  })

  test('a connection without a fetch registry never registers the route', () => {
    const { ctx, captured } = ctxOf({ connection: {}, skills: registryOf(ROWS) })
    watchSkillCatalog(ctx)
    assert.equal(captured.fetch, undefined)
  })

  test('a rejecting registry is swallowed — the plugin stays up, no route', () => {
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => { throw new Error('hostile registry') } } },
      skills: registryOf(ROWS),
    })
    assert.doesNotThrow(() => watchSkillCatalog(ctx))
    assert.equal(captured.fetch, undefined)
  })

  test('the route mounts under its path', () => {
    const captured = armed({ skills: registryOf(ROWS) })
    assert.equal(captured.path, SKILLS_ROUTE)
    assert.equal(typeof captured.fetch, 'function')
  })
})

describe('skills route: the session-addressed resolution', () => {
  test('the session’s observation overrides the body cwd and feeds the preset to the scope lease', async () => {
    const listLog: unknown[] = []
    const disposed: string[] = []
    const leases: (string | undefined)[] = []
    const captured = armed({
      skills: registryOf(ROWS, listLog),
      sessionQuery: queryOf(
        { header: { cwd: '/repo/from-session' }, projections: { values: { agentPreset: 'deep' } } },
        { disposed },
      ),
      agents: { get: () => undefined },
      agentPresets: {
        acquireScope: async (id?: string) => {
          leases.push(id)
          return { key: 'scope-key', [Symbol.asyncDispose]: async () => { disposed.push('lease') } }
        },
      },
    })
    const reply = await serve(captured, { sessionId: 's1', cwd: '/repo/from-body' })
    assert.deepEqual(listLog, [{ cwd: '/repo/from-session', scope: 'scope-key' }], 'the observation’s cwd wins; the lease’s key scopes the read')
    assert.deepEqual(leases, ['deep'], 'the recorded preset selects the standing scope')
    assert.deepEqual(disposed.sort(), ['disposed', 'lease'], 'the observation and the lease both release')
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })

  test('a live agent’s preset-scoped registry wins, scoped by the agent itself', async () => {
    const globalLog: unknown[] = []
    const scopedLog: unknown[] = []
    const agent = { ctx: 'live-agent' }
    const captured = armed({
      skills: registryOf([], globalLog),
      sessionQuery: queryOf({ header: { cwd: '/repo/x' }, projections: { values: {} } }),
      agents: { get: (id: string) => (id === 's1' ? agent : undefined) },
      agentPresets: {
        serviceFor: (a: unknown, name: string) => (a === agent && name === 'skills' ? registryOf(ROWS, scopedLog) : undefined),
        acquireScope: async () => { throw new Error('must not lease for a live agent') },
      },
    })
    await serve(captured, { sessionId: 's1' })
    assert.deepEqual(scopedLog, [{ cwd: '/repo/x', scope: agent }])
    assert.deepEqual(globalLog, [], 'the global registry never reads')
  })

  test('a scoped face without list falls back to the global registry', async () => {
    const globalLog: unknown[] = []
    const captured = armed({
      skills: registryOf(ROWS, globalLog),
      agents: { get: () => ({}) },
      agentPresets: { serviceFor: () => ({ noList: true }) },
    })
    const reply = await serve(captured, { sessionId: 's1' })
    assert.deepEqual(globalLog, [{}], 'unscoped — no live scope, no lease face')
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })

  test('a live agent with no preset faces at all still reads the global registry', async () => {
    const log: unknown[] = []
    const captured = armed({ skills: registryOf(ROWS, log), agents: { get: () => null }, agentPresets: {} })
    await serve(captured, { sessionId: 's1' })
    assert.deepEqual(log, [{}])
  })

  test('a lease without a key scopes nothing', async () => {
    const log: unknown[] = []
    const captured = armed({
      skills: registryOf(ROWS, log),
      agents: { get: () => undefined },
      agentPresets: { acquireScope: async () => ({}) },
    })
    await serve(captured, { sessionId: 's1' })
    assert.deepEqual(log, [{}])
  })

  test('every observation gap leaves the body’s cwd as the only selector', async () => {
    const bodies: unknown[] = [{ sessionId: 's1', cwd: '/repo/body' }, { sessionId: '', cwd: '/repo/body' }, { sessionId: 7, cwd: '/repo/body' }]
    for (const query of [undefined, {}, { observeSession: 42 }, queryOf(null, { throws: true }), queryOf(null)]) {
      const log: unknown[] = []
      const captured = armed({ skills: registryOf([], log), ...(query === undefined ? {} : { sessionQuery: query }) })
      for (const body of bodies) await serve(captured, body)
      assert.deepEqual(log, bodies.map(() => ({ cwd: '/repo/body' })))
    }
  })

  test('a throwing agents face and a throwing lease both degrade to the unscoped global read', async () => {
    const log: unknown[] = []
    const captured = armed({
      skills: registryOf(ROWS, log),
      agents: { get: () => { throw new Error('hostile agents') } },
      agentPresets: { acquireScope: async () => { throw new Error('unknown preset') } },
    })
    const reply = await serve(captured, { sessionId: 's1' })
    assert.deepEqual(log, [{}])
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })

  test('an absent or unusable registry answers a typed null', async () => {
    for (const skills of [undefined, {}, { list: 42 }]) {
      assert.deepEqual(await serve(armed(skills === undefined ? {} : { skills })), { ok: true, value: null })
    }
  })

  test('a throwing registry, a non-array listing, or a broken body never throw into the transport', async () => {
    assert.deepEqual(await serve(armed({ skills: registryOf(new Error('disk down')) })), { ok: true, value: null })
    assert.deepEqual(await serve(armed({ skills: registryOf('not an array') })), { ok: true, value: { skills: [] } })
    const captured = armed({ skills: registryOf(ROWS) })
    const response = await captured.fetch!(new Request('http://localhost' + SKILLS_ROUTE, { method: 'POST', body: 'not json' }))
    assert.deepEqual(await response.json(), { ok: true, value: null })
  })

  test('a hostile lease disposer is swallowed after the read landed', async () => {
    const captured = armed({
      skills: registryOf(ROWS),
      agentPresets: {
        acquireScope: async () => ({ key: 'k', [Symbol.asyncDispose]: async () => { throw new Error('hostile dispose') } }),
      },
    })
    const reply = await serve(captured, { sessionId: 's1' })
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })
})

describe('skills route outcomes', () => {
  test('the registry’s summaries narrow to the wire entries — name, description, path, source only', async () => {
    const reply = await serve(armed({ skills: registryOf(ROWS) }))
    assert.deepEqual(reply, {
      ok: true,
      value: {
        skills: [
          { name: 'tdd', description: 'Test-driven development', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents' },
          { name: 'ask-matt', description: 'A router', source: 'project-agents' },
        ],
      },
    })
  })

  test('the body’s cwd alone selects the project layer when no session services compose', async () => {
    const log: unknown[] = []
    const captured = armed({ skills: registryOf([], log) })
    await serve(captured, { cwd: '/repo/alpha' })
    await serve(captured, {})
    await serve(captured, { cwd: 42 })
    await serve(captured, { cwd: '' })
    await serve(captured, 'not a record')
    assert.deepEqual(log, [{ cwd: '/repo/alpha' }, {}, {}, {}, {}])
  })

  test('entries failing the name proof drop whole; description defaults empty; path/source ride only when proved', async () => {
    const registry = registryOf([
      null,
      'row',
      [],
      { description: 'no name' },
      { name: '' },
      { name: 42 },
      { name: 'bare' },
      { name: 'odd', description: 7, path: '', source: '' },
    ])
    assert.deepEqual(await serve(armed({ skills: registry })), {
      ok: true,
      value: { skills: [{ name: 'bare', description: '' }, { name: 'odd', description: '' }] },
    })
  })

  test('the serve bound caps a runaway registry', async () => {
    const registry = registryOf(Array.from({ length: 600 }, (_, i) => ({ name: `s${i}` })))
    const reply = await serve(armed({ skills: registry }))
    const value = reply.value as { skills: unknown[] }
    assert.equal(value.skills.length, 500)
  })
})
