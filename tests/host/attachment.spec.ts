// The attachment-location route (src/host/attachment.ts): session-authorized named-path resolution
// for verbatim file attachments, plus the route's gating/transport behavior.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach } from 'vitest'
import { ATTACHMENT_ROUTE, referencedAttachmentOf, imagePreviewNameOf, watchAttachmentChannel } from '../../src/host/attachment'
import type { ColdReadGate } from '../../src/host/coldRead'

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessionQuery?: unknown
  attachments?: unknown
}

/** The fleet route spec's host ctx double: cordis inject semantics over a service map. */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  if ('attachments' in spec) services.set('attachments', spec.attachments)
  const ctx = {
    get: (name: string) => services.get(name),
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

const OPEN_GATE: ColdReadGate = { admit: read => read() }
const SKIP_GATE: ColdReadGate = { admit: () => Promise.resolve(undefined) }

function armed(spec: CtxSpec = {}, gate: ColdReadGate = OPEN_GATE): { captured: { path?: string; fetch?: RouteFetch } } {
  const { ctx, captured } = ctxOf({ connection: { fetch: { register: () => () => {} } }, ...spec })
  watchAttachmentChannel(ctx, gate)
  return { captured }
}

async function call(captured: { fetch?: RouteFetch }, body: unknown): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${ATTACHMENT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

const BARE_IMAGE_EVENT = {
  type: 'user/message',
  seq: 10,
  time: 2,
  data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:i2' } }] },
}

/** The screenshot session's own content: three verbatim files, then an image, then the text. */
const USER_EVENT = {
  type: 'user/message',
  seq: 9,
  time: 1,
  data: {
    content: [
      { type: 'file', attachment: { attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 } },
      { type: 'file', attachment: { attachmentId: 'sha256:f2', name: 'report.docx', bytes: 778285 } },
      { type: 'image', attachment: { attachmentId: 'sha256:i1', name: 'result-image.jpg', mediaType: 'image/jpeg', bytes: 146227, width: 1568, height: 1350 } },
      { type: 'text', text: 'how many files?' },
    ],
  },
}

function observing(events: unknown): { observeSession(id: string, options: unknown): Promise<unknown>; disposed(): boolean } {
  let disposed = false
  return {
    observeSession: () => Promise.resolve({
      events,
      [Symbol.dispose]() { disposed = true },
    }),
    disposed: () => disposed,
  }
}

const ALIAS = '/home/me/.dsh/attachments/v1/files/a3/a3f0/report.md'

describe('referencedAttachmentOf', () => {
  test('finds the block citing the id at every real citation site', () => {
    assert.deepEqual(
      referencedAttachmentOf([USER_EVENT], 'sha256:f1'),
      { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 },
    )
    // A tool result's own content, and a nested block inside it.
    assert.deepEqual(
      referencedAttachmentOf([
        { type: 'tool/result', seq: 2, time: 2, data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:i9', width: 1, height: 1 } }] } } },
      ], 'sha256:i9'),
      { kind: 'image', attachmentId: 'sha256:i9', width: 1, height: 1 },
    )
    assert.deepEqual(
      referencedAttachmentOf([
        {
          type: 'tool/result',
          seq: 3,
          time: 3,
          data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: { attachmentId: 'sha256:i10', width: 2, height: 2 } }] }] } },
        },
      ], 'sha256:i10'),
      { kind: 'image', attachmentId: 'sha256:i10', width: 2, height: 2 },
    )
    // A spliced inbox delivery, before its user/message materializes.
    assert.deepEqual(
      referencedAttachmentOf([
        { type: 'agent/inbox/spliced', seq: 4, time: 4, data: { target: 'next-turn', inserted: [{ content: [{ type: 'file', attachment: { attachmentId: 'sha256:f9', name: 'delivered.md', bytes: 7 } }] }] } },
      ], 'sha256:f9'),
      { kind: 'file', attachmentId: 'sha256:f9', name: 'delivered.md', bytes: 7 },
    )
  })

  test('the walk is bounded and total over a hostile log', () => {
    // Deeper than the cap: the block is out of reach, so nothing resolves.
    let deep: Record<string, unknown> = { type: 'file', attachment: { attachmentId: 'sha256:deep', name: 'x.md', bytes: 1 } }
    for (let i = 0; i < 10; i++) deep = { nest: deep }
    assert.equal(referencedAttachmentOf([{ type: 'user/message', data: deep }], 'sha256:deep'), null)
    // An object that throws on the walk drops that event, and the next one still serves.
    const hostile = new Proxy({}, { ownKeys() { throw new Error('hostile payload') } })
    assert.equal(referencedAttachmentOf([{ type: 'x', data: hostile }], 'sha256:f1'), null)
    assert.deepEqual(
      referencedAttachmentOf([{ type: 'x', data: hostile }, USER_EVENT], 'sha256:f1'),
      { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 },
    )
  })

  test('an id the log never cites resolves null, over hostile entries', () => {
    assert.equal(referencedAttachmentOf([USER_EVENT], 'sha256:other'), null)
    assert.equal(referencedAttachmentOf([], 'sha256:f1'), null)
    assert.equal(
      referencedAttachmentOf([
        null,
        42,
        { type: 'x' },
        { type: 'x', data: null },
        { type: 'x', data: { content: 'not-an-array' } },
        { type: 'x', data: { content: [null, 'plain', { type: 'file' }] } },
        { type: 'x', data: { message: null } },
      ], 'sha256:f1'),
      null,
    )
  })
})

describe('watchAttachmentChannel gating', () => {
  test('no route without the connection service or its fetch registry', () => {
    assert.equal(ctxOf({}).captured.path, undefined)
    assert.equal(ctxOf({ connection: {} }).captured.path, undefined)
    assert.equal(ctxOf({ connection: { fetch: {} } }).captured.path, undefined)
    assert.equal(armed().captured.path, ATTACHMENT_ROUTE)
  })

  test('a rejecting registry keeps the route absent without throwing', () => {
    const ctx = {
      get: (name: string) => name === 'connection'
        ? {
          fetch: {
            register: () => {
              throw new Error('registration rejected')
            },
          },
        }
        : undefined,
      inject(_deps: string[], cb: (c: unknown) => unknown) { cb(ctx) },
    }
    assert.doesNotThrow(() => { watchAttachmentChannel(ctx as unknown as Context, OPEN_GATE) })
  })

  test('bad bodies, a missing session, and a missing attachment are typed failures', async () => {
    const { captured } = armed()
    const badJson = await captured.fetch!(new Request(`http://dsh.test${ATTACHMENT_ROUTE}`, { method: 'POST', body: '{' }))
    assert.equal((await badJson.json() as { ok: boolean }).ok, false)
    for (const body of [undefined, null, {}, { sessionId: 42 }, { sessionId: '' }, { sessionId: 's1' }, { sessionId: 's1', attachmentId: 7 }, { sessionId: 's1', attachmentId: '' }]) {
      const r = await call(captured, body)
      assert.equal(r.ok, false, JSON.stringify(body))
    }
  })

  test('no sessionQuery, a verbless query, or a skipped read answers a typed null', async () => {
    assert.deepEqual(await call(armed().captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: {} }).captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: observing(null) }).captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    const skipped = armed({ sessionQuery: observing([USER_EVENT]) }, SKIP_GATE)
    assert.deepEqual(await call(skipped.captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: null })
  })

  test('an id the session never cited resolves null (the authorization rule)', async () => {
    const query = observing([USER_EVENT])
    const { captured } = armed({ sessionQuery: query })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:invented' }), { ok: true, value: null })
    assert.equal(query.disposed(), true)
  })

  test('a throwing observation surfaces as an internal failure', async () => {
    const { captured } = armed({ sessionQuery: { observeSession: () => Promise.reject(new Error('log unreadable')) } })
    const r = await call(captured, { sessionId: 's1', attachmentId: 'a' })
    assert.equal(r.ok, false)
    assert.equal((r.error as { message: string }).message, 'log unreadable')
    const nonError = armed({ sessionQuery: { observeSession: () => Promise.reject('nope') } })
    assert.equal(((await call(nonError.captured, { sessionId: 's1', attachmentId: 'a' })).error as { message: string }).message, 'nope')
  })
})

describe('watchAttachmentChannel resolution', () => {
  test('a cited file resolves its named host path and the observation disposes', async () => {
    const query = observing([USER_EVENT])
    const seen: unknown[] = []
    const { captured } = armed({
      sessionQuery: query,
      attachments: {
        fileHostPath: (ref: unknown) => {
          seen.push(ref)
          return ALIAS
        },
      },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: { path: ALIAS } })
    assert.deepEqual(seen, [{ attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 }])
    assert.equal(query.disposed(), true)
  })

  test('a store without an image face answers a typed null for an image', async () => {
    const { captured } = armed({
      sessionQuery: observing([USER_EVENT]),
      attachments: { fileHostPath: () => ALIAS },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:i1' }), { ok: true, value: null })
  })

  test('every unlocatable attachment shape resolves a typed null', async () => {
    const cases: { attachments: unknown; id: string }[] = [
      // No store composed, a store without the verb, and a store answering nothing path-shaped.
      { attachments: undefined, id: 'sha256:f1' },
      { attachments: {}, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => undefined }, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => '' }, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => 42 }, id: 'sha256:f1' },
      // A hostile reference (bad digest, unsanitized name) throws inside the store.
      {
        attachments: {
          fileHostPath: () => {
            throw new Error('invalid attachment ref')
          },
        },
        id: 'sha256:f1',
      },
    ]
    for (const c of cases) {
      const { captured } = armed({ sessionQuery: observing([USER_EVENT]), attachments: c.attachments })
      assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: c.id }), { ok: true, value: null }, JSON.stringify(c))
    }
  })

  test('an observation without a dispose method still serves', async () => {
    const { captured } = armed({
      sessionQuery: { observeSession: () => Promise.resolve({ events: [USER_EVENT] }) },
      attachments: { fileHostPath: () => ALIAS },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: { path: ALIAS } })
  })

  test('a nameless file reference still resolves through the store', async () => {
    const { captured } = armed({
      sessionQuery: observing([{ type: 'user/message', seq: 1, data: { content: [{ type: 'file', attachment: { attachmentId: 'sha256:f3' } }] } }]),
      attachments: { fileHostPath: (ref: unknown) => `${ALIAS}:${JSON.stringify(ref)}` },
    })
    const r = await call(captured, { sessionId: 's1', attachmentId: 'sha256:f3' })
    assert.deepEqual(r.value, { path: `${ALIAS}:${JSON.stringify({ attachmentId: 'sha256:f3', name: '', bytes: 0 })}` })
  })
})

describe('image preview names', () => {
  test('an image keeps a viewable suffix, leaf only', () => {
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'photo.PNG', mediaType: 'image/jpeg' }), 'photo.PNG')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: '../../evil.svg' }), 'evil.svg')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'C:\\tmp\\x.webp' }), 'x.webp')
  })

  test('anything the column cannot view is named by the verified media type', () => {
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'clipboard', mediaType: 'image/jpeg' }), 'attachment.jpg')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'shot.png', mediaType: 'image/webp' }), 'shot.png', 'a suffix a viewer claims keeps the displayed name; the viewer renders the stored bytes')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'scan.tiff', mediaType: 'image/png' }), 'attachment.png')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', mediaType: 'image/gif' }), 'attachment.gif')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', mediaType: 'image/tiff' }), null)
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a' }), null)
  })
})

describe('watchAttachmentChannel image aliases', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /** A real store layout: `<home>/attachments/v1/objects/<xx>/<digest>` holding the image bytes. */
  function storeOf(bytes: string): { home: string; objectPath: string; store: { imageHostPath: () => string } } {
    const home = mkdtempSync(join(tmpdir(), 'dsh-context-att-'))
    homes.push(home)
    const digest = 'ab'.repeat(32)
    const objectPath = join(home, 'attachments', 'v1', 'objects', 'ab', digest)
    mkdirSync(join(home, 'attachments', 'v1', 'objects', 'ab'), { recursive: true })
    writeFileSync(objectPath, bytes)
    return { home, objectPath, store: { imageHostPath: () => objectPath } }
  }

  test('a cited image answers a named hard link under the plugin preview cache', async () => {
    const { home, objectPath, store } = storeOf('image-bytes')
    const { captured } = armed({ sessionQuery: observing([USER_EVENT]), attachments: store })
    const r = await call(captured, { sessionId: 's1', attachmentId: 'sha256:i1' })
    const path = (r.value as { path: string }).path
    assert.equal(path, join(home, 'cache', 'dsh-context', 'previews', 'ab', basename(objectPath), 'result-image.jpg'))
    assert.equal(readFileSync(path, 'utf8'), 'image-bytes', 'the link shares the stored bytes')
    // A second read reuses the link instead of failing on EEXIST.
    const again = await call(captured, { sessionId: 's1', attachmentId: 'sha256:i1' })
    assert.deepEqual(again.value, { path })
  })

  test('an unfamiliar object layout and an unlocatable object both answer a typed null', async () => {
    const flat = armed({
      sessionQuery: observing([USER_EVENT]),
      attachments: { imageHostPath: () => join(tmpdir(), 'objects', 'ab', 'digest') },
    })
    assert.deepEqual(await call(flat.captured, { sessionId: 's1', attachmentId: 'sha256:i1' }), { ok: true, value: null })

    const { home } = storeOf('image-bytes')
    const missing = armed({
      sessionQuery: observing([USER_EVENT]),
      attachments: { imageHostPath: () => join(home, 'attachments', 'v1', 'objects', 'ab', 'gone') },
    })
    assert.deepEqual(await call(missing.captured, { sessionId: 's1', attachmentId: 'sha256:i1' }), { ok: true, value: null })
  })

  test('a hostile or empty image reference resolves a typed null', async () => {
    const cases: { store: unknown; id: string }[] = [
      { store: {}, id: 'sha256:i1' },
      {
        store: {
          imageHostPath: () => {
            throw new Error('invalid attachment ref')
          },
        },
        id: 'sha256:i1',
      },
      { store: { imageHostPath: () => '' }, id: 'sha256:i1' },
      { store: { imageHostPath: () => 42 }, id: 'sha256:i1' },
      // The cited image carries no media type and no usable suffix.
      { store: { imageHostPath: () => '/x/attachments/v1/objects/ab/digest' }, id: 'sha256:i2' },
    ]
    for (const c of cases) {
      const { captured } = armed({ sessionQuery: observing([USER_EVENT, BARE_IMAGE_EVENT]), attachments: c.store })
      assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: c.id }), { ok: true, value: null }, JSON.stringify(c.id))
    }
  })
})
