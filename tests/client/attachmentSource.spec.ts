// The attachment plumbing (src/client/attachmentSource.ts): the location route read behind one
// click, its cache, and the preview-column opener the File Activity card also rides.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  clearAttachmentPaths,
  makeAttachmentLocator,
  makeAttachmentOpener,
  pathOfValue,
} from '../../src/client/attachmentSource'
import type { AttachmentRef } from '../../src/shared/attachment'
import { asClientCtx, TestClientCtx } from './helpers/harness'

const FILE: AttachmentRef = { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 }
const ALIAS = '/home/me/.dsh/attachments/v1/files/a3/a3f0/report.md'

interface Call {
  url: string
  body: unknown
}

/** Stub the global fetch with per-call answers; returns the recorded calls. */
function stubFetch(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    const call: Call = { url, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    return answer(call)
  })
  return calls
}

function json(value: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(value) }
}

afterEach(() => {
  clearAttachmentPaths()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pathOfValue', () => {
  test('proves the envelope down to a non-empty string path', () => {
    assert.equal(pathOfValue({ path: ALIAS }), ALIAS)
    assert.equal(pathOfValue({ path: '' }), null)
    assert.equal(pathOfValue({ path: 42 }), null)
    assert.equal(pathOfValue({}), null)
    assert.equal(pathOfValue(null), null)
    assert.equal(pathOfValue('path'), null)
  })
})

describe('makeAttachmentLocator', () => {
  test('no session means no locator', () => {
    assert.equal(makeAttachmentLocator(undefined), undefined)
    assert.equal(makeAttachmentLocator(''), undefined)
  })

  test('one read resolves the path and the next click reuses it', async () => {
    const calls = stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const locate = makeAttachmentLocator('s1')!
    assert.equal(await locate(FILE), ALIAS)
    assert.equal(await locate(FILE), ALIAS)
    assert.equal(calls.length, 1, 'the second read is served from the cache')
    assert.equal(calls[0].url, 'api/dsh-context/attachment')
    assert.deepEqual(calls[0].body, { sessionId: 's1', attachmentId: 'sha256:f1' })
  })

  test('every refusal resolves null, and none of them is cached', async () => {
    const answers: ((call: Call) => unknown)[] = [
      () => json({ ok: true, value: null }),
      () => json({ ok: false, error: { code: 'x' } }),
      () => json({ ok: true, value: { path: '' } }),
      () => ({ ok: false, json: () => Promise.resolve({}) }),
      () => {
        throw new Error('offline')
      },
      () => json('not-an-envelope'),
    ]
    for (const answer of answers) {
      clearAttachmentPaths()
      const calls = stubFetch(answer)
      const locate = makeAttachmentLocator('s1')!
      assert.equal(await locate(FILE), null)
      assert.equal(await locate(FILE), null)
      assert.equal(calls.length, 2, 'a failed resolution is retried, never cached')
      vi.unstubAllGlobals()
    }
  })

  test('a malformed JSON body resolves null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: () => Promise.reject(new Error('bad json')) }))
    const locate = makeAttachmentLocator('s1')!
    assert.equal(await locate(FILE), null)
  })

  test('the cache is bounded: the oldest path is dropped first', async () => {
    const calls = stubFetch(call => json({ ok: true, value: { path: `${ALIAS}#${String((call.body as { attachmentId: string }).attachmentId)}` } }))
    const locate = makeAttachmentLocator('s1')!
    for (let i = 0; i < 33; i++) {
      await locate({ kind: 'file', attachmentId: `sha256:f${String(i)}`, name: 'x.md' })
    }
    assert.equal(calls.length, 33)
    // The first id fell out of the 32-entry cache, so it reads again; the newest stays cached.
    await locate({ kind: 'file', attachmentId: 'sha256:f0', name: 'x.md' })
    assert.equal(calls.length, 34)
    await locate({ kind: 'file', attachmentId: 'sha256:f32', name: 'x.md' })
    assert.equal(calls.length, 34)
  })
})

describe('makeAttachmentOpener', () => {
  test('without a session or a preview column there is no opener', async () => {
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const bare = new TestClientCtx()
    assert.equal(makeAttachmentOpener(asClientCtx(bare), undefined, undefined), undefined)
    assert.equal(makeAttachmentOpener(asClientCtx(bare), '', undefined), undefined)
    assert.equal(makeAttachmentOpener(asClientCtx(bare), 's1', undefined), undefined)
  })

  test('a resolved path opens the harness preview column at the session file address', async () => {
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openResource: (address: string) => { opened.push(address) } } } })
    const open = makeAttachmentOpener(asClientCtx(ctx), 's1', '/work/repo')!
    assert.equal(await open(FILE), true)
    assert.equal(opened.length, 1)
    assert.ok(opened[0].startsWith('dsh-resource://file/session/s1/'), opened[0])
    assert.ok(opened[0].endsWith('report.md'), opened[0])
    assert.ok(opened[0].includes('/home/me/.dsh/attachments/v1/files/a3/a3f0/'), 'an absolute path outside the workspace stays absolute')
  })

  test('an image-formed file keeps its stored name in the address', async () => {
    stubFetch(() => json({ ok: true, value: { path: '/store/a3/shot.PNG' } }))
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openResource: (address: string) => { opened.push(address) } } } })
    const open = makeAttachmentOpener(asClientCtx(ctx), 's1', undefined)!
    assert.equal(await open({ kind: 'file', attachmentId: 'sha256:f9', name: 'shot.PNG' }), true)
    assert.ok(opened[0].endsWith('shot.PNG'))
  })

  test('an unresolved path and a refused address both report false', async () => {
    stubFetch(() => json({ ok: true, value: null }))
    const refused: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openResource: (address: string) => { refused.push(address) } } } })
    const open = makeAttachmentOpener(asClientCtx(ctx), 's1', undefined)!
    assert.equal(await open(FILE), false)
    assert.deepEqual(refused, [], 'nothing to open, the column is never called')

    clearAttachmentPaths()
    vi.unstubAllGlobals()
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const throwing = new TestClientCtx({
      services: {
        sidebarRight: {
          openResource: () => {
            throw new Error('no viewer claims it')
          },
        },
      },
    })
    const openThrowing = makeAttachmentOpener(asClientCtx(throwing), 's1', undefined)!
    assert.equal(await openThrowing(FILE), false)
  })
})
