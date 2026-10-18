import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { watchHistoryFaces } from '../../../src/client/historyPage'
import type { UseChatLike } from '../../../src/client/services'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, mount, queryAll, text } from '../helpers/kit'
import { makeView, mountInScroller, projectionsFor, richTimeline, timeline } from './contextViewHarness'

describe('ContextView — targeted content fetch and image loading', () => {
  test('opening an un-joined node reads one seq-anchored history page through the gateway remote', async () => {
    const calls: { sessionId: string; throughSeq: number; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({
      services: {
        remote: {
          session: {
            page: (request: { address: { sessionId: string }; throughSeq: number; beforeSeq: number }) => {
              calls.push({ sessionId: request.address.sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq })
              return Promise.resolve({
                ok: true,
                value: {
                  records: [
                    { type: 'event', event: { type: 'user/message', seq: request.throughSeq, data: { content: [{ type: 'text', text: 'OLD FULL BODY' }] } } },
                  ],
                },
              })
            },
          },
        },
      },
    })
    // The direct `remote.session` service is hostile, as on the real host: the face resolves only through the declared inject.
    ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    watchHistoryFaces(asClientCtx(ctx))
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-page',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    // The lone node auto-expands with the category, which triggers the fetch.
    await click(catRow)
    await flush()
    assert.deepEqual(calls, [{ sessionId: 'sv-page', throughSeq: 1, beforeSeq: 2 }], 'one read anchored just past the seq')
    assert.ok(text(m.container).includes('OLD FULL BODY'), 'mapped page content renders')
    await m.unmount()
    // Unload the declared slot so no face stales into the next test.
    ctx.dispose()
  })

  test('without a history face an uncached node shows the static note', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-nopage',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    assert.ok(text(m.container).includes(DICT_EN['browser.noContent']))
    await m.unmount()
  })

  test('image attachments resolve through the conversation service loader', async () => {
    const resolved: [string, unknown][] = []
    const ctx = new TestClientCtx({
      services: {
        uiConversation: {
          imageUrl: (sessionId: string, attachment: unknown) => {
            resolved.push([sessionId, attachment])
            return Promise.resolve('blob:pic')
          },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-img',
      useProjection: projectionsFor(timeline({
        images: 1,
        nodes: [{ seq: 1, cat: 'user', tokens: 400, text: 'see this', imgs: 1 }],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [{
            kind: 'user',
            seq: 1,
            content: [{ type: 'image', attachment: { attachmentId: 'att-1', name: 'pic.png', bytes: 2048, width: 640, height: 480 } }],
          }] }
        })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await flush()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0][0], 'sv-img')
    assert.equal((resolved[0][1] as { attachmentId: string }).attachmentId, 'att-1')
    assert.ok(m.container.querySelector('.lc-att-item img') !== null)
    await m.unmount()
  })

  test('a conversation service without imageUrl degrades quietly', async () => {
    const ctx = new TestClientCtx({ services: { uiConversation: {} } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-noimg',
      useProjection: projectionsFor(timeline()),
    }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    await m.unmount()
  })
})

describe('ContextView — scroll ledger', () => {
  test('restores the saved position per session and re-applies only once per mount', async () => {
    const View = makeView(new TestClientCtx())
    const props = {
      sessionId: 'sv-scroll',
      useProjection: undefined as ((key: string) => unknown) | undefined,
    }

    // First visit: no ledger entry → the shared scroller is re-anchored at top.
    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller1,
    )
    assert.equal(scroller1.scrollTop, 0)

    // A data refresh re-runs the effect but the position is applied once.
    scroller1.scrollTop = 17
    await m1.update(h(View, { ...props, useProjection: projectionsFor(richTimeline({ droppedNodes: 3 })) }))
    assert.equal(scroller1.scrollTop, 17)

    // Unmount saves the position into the module ledger.
    scroller1.scrollTop = 42
    await m1.unmount()

    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    const m2 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller2,
    )
    assert.equal(scroller2.scrollTop, 42)
    await m2.unmount()
  })
})
