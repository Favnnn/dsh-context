// The client's open verbs (src/client/services.ts): the workspace-path remote gate, the
// Sidebar resource openers, the aside subagent-chat opener, and the view-owner session jump.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  canOpenPathsOf,
  openChildAsideVia,
  openPathVia,
  openResourceVia,
  openSessionVia,
  subagentChatAddressOf,
} from '../../src/client/services'
import type { ClientCtx } from '../../src/client/services'

/** The minimal client face: `ctx.get(name)` reading from a service record. */
const ctxWith = (services: Record<string, unknown>): ClientCtx =>
  ({ get: (name: string) => services[name] }) as unknown as ClientCtx

describe('canOpenPathsOf / openPathVia', () => {
  /** A loopback connection whose generic RPC answers per endpoint. */
  const rpcConn = (routes: Record<string, () => unknown>, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    isLoopback: true,
    rpc: { call: (channel: string, endpoint: string) => Promise.resolve(routes[endpoint]?.()) },
    ...over,
  })
  const openable = (): Record<string, unknown> =>
    rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: true }) })

  test('the capability remote gates the opener, behind the loopback fact', async () => {
    assert.equal(await canOpenPathsOf(ctxWith({ connection: openable() })), true)
    // The remote's answer is re-proved: non-true values and failed results are both "no".
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => 'garbage' }) })), false)
    // The harness's own gate: a page not on the operator's machine never opens.
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: false, rpc: openable().rpc } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({})), false)
  })

  test('hostile connections and failed transports resolve false, never reject', async () => {
    const throwProp = (): never => { throw new Error('boom') }
    // A service lookup itself may throw.
    assert.equal(await canOpenPathsOf({ get: throwProp } as unknown as ClientCtx), false)
    // An rpc face whose call read throws; a loopback fact that throws on read.
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { get call(): unknown { return throwProp() } } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { get isLoopback(): boolean { return throwProp() }, rpc: openable().rpc } })), false)
    // A call that is not a function, and one that rejects.
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: 7 } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: () => Promise.reject(new Error('offline')) } } })), false)
  })

  test('openPathVia returns a fire-and-forget caller that swallows failures', async () => {
    const open = openPathVia(ctxWith({ connection: { rpc: { call: () => Promise.reject(new Error('no desktop')) } } }))
    assert.ok(open !== undefined)
    open('/repo/a.ts') // must not throw
    // A synchronously throwing transport joins the same silence.
    const syncThrow = openPathVia(ctxWith({ connection: { rpc: { call: () => { throw new Error('sync') } } } }))
    syncThrow!('/repo/a.ts')
    assert.equal(openPathVia(ctxWith({})), undefined)
  })

  test('the opener forwards the requested path through the open remote', async () => {
    const calls: { channel: string; endpoint: string; payload: unknown }[] = []
    const open = openPathVia(ctxWith({
      connection: {
        rpc: {
          call: (channel: string, endpoint: string, payload: unknown) => {
            calls.push({ channel, endpoint, payload })
            return Promise.resolve({ ok: true, value: { opened: true } })
          },
        },
      },
    }))
    open!('/repo/a.ts')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, [{ channel: '/api', endpoint: 'session/openWorkspacePath', payload: { args: { request: { path: '/repo/a.ts' } } } }])
  })
})

describe('openResourceVia', () => {

  test('forwards the address to the Sidebar face and reports the open', () => {
    const opened: string[] = []
    const open = openResourceVia(ctxWith({ sidebarRight: { openResource: (address: string) => { opened.push(address) } } }))
    assert.ok(open !== undefined)
    assert.equal(open('dsh-resource://file/session/s1/a.ts'), true)
    assert.deepEqual(opened, ['dsh-resource://file/session/s1/a.ts'])
  })

  test('forwards the opener options beside the address', () => {
    const calls: { address: string; options: unknown }[] = []
    const open = openResourceVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }))
    assert.equal(open!('dsh-resource://file/session/s1/a.ts', { kind: 'subagentchat', preferNewPane: true }), true)
    assert.deepEqual(calls, [{ address: 'dsh-resource://file/session/s1/a.ts', options: { kind: 'subagentchat', preferNewPane: true } }])
  })

  test('an absent or hostile face yields no opener at all', () => {
    assert.equal(openResourceVia(ctxWith({})), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: null })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: {} })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: { openResource: 7 } })), undefined)
    // A service lookup itself may throw.
    assert.equal(openResourceVia({ get: () => { throw new Error('boom') } } as unknown as ClientCtx), undefined)
  })

  test('a refusal reports false instead of throwing, so the caller can fall back', () => {
    const open = openResourceVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }))
    assert.equal(open!('dsh-resource://file/session/s1/a.ts'), false)
  })

  test('the face is re-proved per call: a revoked service refuses after the opener was built', () => {
    const services: Record<string, unknown> = { sidebarRight: { openResource: () => {} } }
    const open = openResourceVia(ctxWith(services))
    assert.ok(open !== undefined)
    // The plugin unloaded (HMR): the written face is gone.
    services.sidebarRight = undefined
    assert.equal(open('dsh-resource://file/session/s1/a.ts'), false)
  })
})

describe('openSessionVia', () => {

  test('jumps through the view owner — every supported line\'s own verb (issue #90)', () => {
    // Exactly the supported composition: uiWorkspace serves the navigation
    // verb, the sessions service carries no selection at all.
    const opened: string[] = []
    openSessionVia(ctxWith({
      uiWorkspace: { openSession(id: string) { opened.push(id) } },
      sessions: { list: { getSnapshot: () => ({}) } },
    }), 's2')
    assert.deepEqual(opened, ['s2'])
  })

  test('the verb is invoked bound to its service instance', () => {
    let seen: unknown
    const face = {
      target: 's4',
      openSession(this: { target: string }, id: string) { seen = `${this.target}:${id}` },
    }
    openSessionVia(ctxWith({ uiWorkspace: face }), 's4')
    assert.equal(seen, 's4:s4')
  })

  test('a composition without the workspace module, or a verb-less face, swallows silently', () => {
    openSessionVia(ctxWith({}), 's5')
    openSessionVia(ctxWith({ uiWorkspace: {} }), 's5')
    openSessionVia(ctxWith({ uiWorkspace: { openSession: 7 } }), 's5')
  })

  test('a hostile face never throws into the click handler', () => {
    openSessionVia(ctxWith({ uiWorkspace: { openSession: () => { throw new Error('boom') } } }), 's6')
    // A traced proxy can throw on the property READ itself (issue #42).
    openSessionVia(ctxWith({ uiWorkspace: { get openSession() { throw new Error('boom') } } }), 's6')
    openSessionVia({ get: () => { throw new Error('boom') } } as unknown as ClientCtx, 's6')
  })
})

describe('openChildAsideVia', () => {

  test('the address mirrors the shipped catalog\'s canonical spelling', () => {
    assert.equal(
      subagentChatAddressOf({ parentSessionId: 'p1', childSessionId: 'c/1', mode: 'continuable' }),
      'dsh-resource://subagentchat/session/c%2F1?parent=p1&mode=continuable',
    )
  })

  test('opens the aside resource with the catalog\'s own options', () => {
    const calls: { address: string; options: unknown }[] = []
    const ok = openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1', mode: 'one-shot' })
    assert.ok(ok)
    assert.deepEqual(calls, [{
      address: 'dsh-resource://subagentchat/session/c1?parent=p1&mode=one-shot',
      options: { kind: 'subagentchat', preferNewPane: true },
    }])
  })

  test('a row without its subagent projection rides the harness\'s own unknown mode', () => {
    const calls: { address: string; options: unknown }[] = []
    openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1' })
    assert.equal(calls[0]?.address, 'dsh-resource://subagentchat/session/c1?parent=p1&mode=unknown')
  })

  test('a parent-less address refuses without touching the face', () => {
    const opened: string[] = []
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: (a: string) => { opened.push(a) } } }), { childSessionId: 'c1' }),
      false,
    )
    assert.deepEqual(opened, [])
  })

  test('an absent column, or an address no type claims, reports false — the caller keeps its jump', () => {
    const address = { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable' } as const
    assert.equal(openChildAsideVia(ctxWith({}), address), false)
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }), address),
      false,
    )
  })
})
