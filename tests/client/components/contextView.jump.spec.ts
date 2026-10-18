import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, mount, query, queryAll, text } from '../helpers/kit'
import { buttonByText, makeView, mountInScroller, mountRich, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — chat→Context jump', () => {
  test('the relay flips the chart to turn bars, pins the reply\'s turn, and consumes itself', async () => {
    // The clicked reply closed turn 1: its request seq (4) is that turn's LAST step — exactly the aggregate's record.
    requestContextFocus('sv-jump', 4)
    const m = await mountRich('sv-jump')
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'), 'granularity flips to turn')
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'the chart renders turn aggregates')
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the reply\'s turn bar is pinned')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-jump'), null, 'the relay is one-shot')
    await m.unmount()
  })

  test('no session id: the relay stays pending — the loading view never takes it', async () => {
    requestContextFocus('sv-jumpnone', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
    assert.equal(takeContextFocus('sv-jumpnone'), 4, 'an absent session id skips leg 1')
    takeContextFocus('sv-jumpnone')
  })

  test('an empty history consumes the relay and pins nothing', async () => {
    requestContextFocus('sv-jumpempty', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-jumpempty', useProjection: projectionsFor(timeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.equal(takeContextFocus('sv-jumpempty'), null)
    await m.unmount()
  })

  test('a turn-less reply routes to the turn-0 bar', async () => {
    // The trailing turn-less step: its group key derives to 0, the ?? 0 arm.
    requestContextFocus('sv-jump0', 6)
    const m = await mountRich('sv-jump0')
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-selected'))
    assert.equal(takeContextFocus('sv-jump0'), null)
    await m.unmount()
  })

  test('a record landing after mount re-pins the mounted view (the sidebar repeat jump)', async () => {
    const m = await mountRich('sv-rejump')
    assert.ok(!query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'nothing pinned at mount')
    // The sidebar landing keeps this view mounted; a later jump must re-pin it.
    await act(async () => { requestContextFocus('sv-rejump', 4) })
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the later record re-pins')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-rejump'), null, 'the record was consumed')
    await m.unmount()
  })

  test('the jump reveals the Current Composition card even over a restored position', async () => {
    const View = makeView(new TestClientCtx())
    const props = { sessionId: 'sv-jumpscroll', useProjection: projectionsFor(richTimeline()) }

    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(h(View, props), scroller1)
    scroller1.scrollTop = 42
    await m1.unmount()

    // jsdom lays out nothing: give the scroller and the composition card fixed
    // viewport tops so the reveal's rect delta is deterministic (450 − 100).
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.hasAttribute('data-lc-current') ? 450 : 0
      return { top } as DOMRect
    })

    // The jump remount: restore applies 42, then the jump resolves and the
    // reveal scrolls the composition card to the scrollport's top (42 + 350).
    // jsdom reports 0 for both — the scroller must overflow to be operative.
    requestContextFocus('sv-jumpscroll', 4)
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    scroller2.style.overflowY = 'auto'
    Object.defineProperty(scroller2, 'scrollHeight', { value: 800 })
    Object.defineProperty(scroller2, 'clientHeight', { value: 300 })
    const m2 = await mountInScroller(h(View, props), scroller2)
    assert.equal(scroller2.scrollTop, 392, 'restore(42) overridden by the card reveal delta(350)')
    assert.ok(query(m2.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m2.unmount()
    gBCR.mockRestore()
  })
})

describe('ContextView — the stats board\'s pill jumps', () => {
  /** One user message, one read and one write op, so both jump families have a landing spot. */
  function jumpTimeline(): ReturnType<typeof timeline> {
    return timeline({
      humanInputs: 1,
      requests: [{ seq: 2, turn: 1, step: 1, time: T0, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 0, total: 60 }],
      nodes: [{ seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 }],
      fileOps: [
        { seq: 3, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0, read: { start: 1, count: 3 } },
        { seq: 4, path: '/src/a.ts', kind: 'write', tool: 'edit', err: false, added: 2, removed: 1 },
      ],
    })
  }

  test('the input pill opens the browser\'s user messages; a file pill picks the card\'s kind chip and scrolls it in', async () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 900 })
    Object.defineProperty(scroller, 'clientHeight', { value: 300 })
    // jsdom lays out nothing: fixed viewport tops make each reveal's rect delta deterministic, shifted by the scroll the
    // reveal itself applies — the same live geometry a real page reports (450 − 100, then 700 − 100 on top of that).
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const inScroller = !this.hasAttribute('data-conversation-scroll')
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.classList.contains('lc-col-browser') ? 450
          : this.classList.contains('lc-fa-card') ? 700 : 0
      return { top: inScroller ? top - scroller.scrollTop : top } as DOMRect
    })
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-pilljump', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      const pill = (label: string): HTMLElement => {
        const hit = queryAll(m.container, '.lc-flow-pill').find(el => text(el).startsWith(label))
        if (hit === undefined) throw new Error(`pill not found: ${label}`)
        return hit
      }
      const fileCard = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
      assert.ok(fileCard !== undefined)
      const chip = (label: string): HTMLElement => {
        const hit = queryAll(fileCard, '.lc-fa-ctl .lc-gran-btn').find(b => text(b).startsWith(label))
        if (hit === undefined) throw new Error(`chip not found: ${label}`)
        return hit
      }

      await click(pill(DICT_EN['stats.humanInputs']))
      await flush()
      const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes(DICT_EN['cat.user']), 'the user category opens')
      assert.ok(text(open[0].parentElement as HTMLElement).includes('hello there'), 'its messages show')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')

      await click(pill(DICT_EN['files.kind.read']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'))
      assert.equal(queryAll(fileCard, '.lc-fa-row').length, 1, 'the read filter narrows the list')
      assert.equal(scroller.scrollTop, 600, 'the File Activity card scrolled to the scrollport top')

      await click(pill(DICT_EN['files.kind.write']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.write']).className.includes('lc-gran-on'))
      assert.ok(!chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'), 'the previous jump is replaced')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })
})
