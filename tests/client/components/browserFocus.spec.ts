import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import type { ContextHeaders } from '../../../src/shared/types'
import type { ConversationNodeLike } from '../../../src/client/services'
import { click, mount, query, queryAll, surfaceNode, text } from '../helpers/kit'
import { Browser, catRow, pickStep, props, req, tl } from './browserHarness'

describe('ContextBrowser focus bridges', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, systemTokens: 3,
      tools: [
        { name: 'beta', tokens: 50 },
        { name: 'alpha', tokens: 10 },
      ],
    }],
  }
  const data = tl({
    current: { system: 10, tools: 60, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 80 },
    requests: [req({ seq: 10, turn: 1, step: 0, total: 80 }), req({ seq: 20, turn: 1, step: 1, total: 80 })],
    nodes: [surfaceNode({ seq: 1, tokens: 5, text: 'focusable' }), surfaceNode({ seq: 11, cat: 'assistant', tokens: 5, text: 'answer' })],
  })
  const convNodes: ConversationNodeLike[] = [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'focusable' }] }]

  test('nodeFocus selects the step, opens the node, reveals it within the card only, and clears', async () => {
    const scrolls: unknown[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolls.push(arg) } as never
    try {
      let handled = 0
      const m = await mount(h(Browser, props({ data, headers, convNodes })))
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 'live', key: 'n1', cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.equal(handled, 1)
      const onRows = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(onRows.length, 1)
      assert.ok(text(onRows[0]).includes('focusable'))
      assert.deepEqual(scrolls, [], 'the open row reveals inside the card — never a scrollIntoView that could drag the page')
      // A step focus switches the assembled view.
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 20, key: 'n1', cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 1'))
      assert.equal(handled, 2)
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 'live', key: 'n999', cat: 'user' },
      })))
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0)
      await m.unmount()
    } finally {
      Element.prototype.scrollIntoView = orig
    }
  })

  test('pinSeq selects the pinned step and unpinning returns to live (accordion resets)', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'user'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 1)
    await m.update(h(Browser, props({ data, headers, pinSeq: 10 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 0'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'pinning resets the accordion')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '10')
    await m.update(h(Browser, props({ data, headers, pinSeq: null })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    await m.unmount()
  })
})

describe('ContextBrowser — the split generation detail states', () => {
  test('a pending detail read names the state on the note strip', async () => {
    const m = await mount(h(Browser, { data: tl({}), headers: null, detailState: 'loading' }))
    assert.ok(text(m.container).includes(DICT_EN['detail.loading']))
    // The picker still offers the live surface (the sections read zero until the detail lands).
    assert.equal(queryAll(m.container, '.lc-br-pick option').length, 1)
    await m.unmount()
  })

  test('a failed detail read arms the retry button on the strip', async () => {
    let retries = 0
    const m = await mount(h(Browser, {
      data: tl({}),
      headers: null,
      detailState: 'failed',
      onDetailRetry: () => { retries++ },
    }))
    await click(query(m.container, '.lc-br-retry'))
    assert.equal(retries, 1)
    await m.unmount()
  })

  test('a landed (or inline) detail renders no strip', async () => {
    for (const state of ['ready', 'legacy'] as const) {
      const m = await mount(h(Browser, { data: tl({}), headers: null, detailState: state }))
      assert.ok(!text(m.container).includes(DICT_EN['detail.loading']))
      assert.ok(!text(m.container).includes(DICT_EN['detail.loadFailed']))
      await m.unmount()
    }
    // And the prop-less caller (older hosts) renders nothing either.
    const m = await mount(h(Browser, { data: tl({}), headers: null }))
    assert.ok(queryAll(m.container, '.lc-br-retry').length === 0)
    await m.unmount()
  })
})

describe('ContextBrowser open-category reporting', () => {
  test('toggling categories and step picks report the open category outward', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 2, step: 0 })],
      nodes: [
        surfaceNode({ seq: 1, cat: 'user', text: 'hi' }),
        surfaceNode({ seq: 2, cat: 'user', text: 'again' }),
        surfaceNode({ seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'out' }),
      ],
    })
    const opens: (string | null)[] = []
    const onOpenCat = (c: string | null): void => { opens.push(c) }
    const m = await mount(h(Browser, props({ data, onOpenCat })))
    assert.deepEqual(opens, [null], 'the mount-time pin pass reports the closed accordion')
    await click(catRow(m, 'user'))
    assert.deepEqual(opens, [null, 'user'])
    await click(catRow(m, 'user'))
    assert.deepEqual(opens, [null, 'user', null])
    await click(catRow(m, 'tool'))
    assert.deepEqual(opens, [null, 'user', null, 'tool'])
    await pickStep(m, '20')
    assert.deepEqual(opens, [null, 'user', null, 'tool', null], 'a step pick closes the open category')
    await m.unmount()
  })

  test('a pin change and a brief reveal report their reset / target category', async () => {
    const data = tl({ requests: [req({ seq: 10, turn: 1, step: 0 })], nodes: [surfaceNode({ seq: 1, cat: 'user', text: 'hi' })] })
    const opens: (string | null)[] = []
    const onOpenCat = (c: string | null): void => { opens.push(c) }
    const m = await mount(h(Browser, props({ data, onOpenCat })))
    await m.update(h(Browser, props({ data, onOpenCat, pinSeq: 10 })))
    assert.deepEqual(opens, [null, null], 'pinning resets the accordion')
    await m.update(h(Browser, props({
      data, onOpenCat, pinSeq: 10,
      nodeFocus: { step: 'live', key: 'n1', cat: 'tool' },
      onNodeFocusHandled: () => {},
    })))
    assert.deepEqual(opens, [null, null, 'tool'], 'the reveal opens the node category')
    await m.unmount()
  })

  test('catFocus opens the named category on the live surface, picking the kind chip', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 })],
      nodes: [
        surfaceNode({ seq: 1, cat: 'skill', tokens: 5, skill: 'pdf', text: 'instructions' }),
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 5, text: 'an answer' }),
        surfaceNode({ seq: 3, cat: 'assistant', tokens: 5, calls: ['bash'] }),
      ],
    })
    const opens: (string | null)[] = []
    const onOpenCat = (c: string | null): void => { opens.push(c) }
    let handled = 0
    const m = await mount(h(Browser, props({ data, onOpenCat })))
    // The stats card's Answers figure: assistant open, the answer chip picked — the tool-call-only row filters out.
    await m.update(h(Browser, props({
      data,
      onOpenCat,
      catFocus: { cat: 'assistant', kind: 'answer' },
      onCatFocusHandled: () => { handled += 1 },
    })))
    assert.equal(handled, 1)
    assert.deepEqual(opens, [null, 'assistant'])
    assert.ok(catRow(m, 'assistant').className.includes('lc-br-cat-open'))
    const assistantCat = catRow(m, 'assistant').parentElement as HTMLElement
    const chips = queryAll(assistantCat, '.lc-gran-btn')
    const answerChip = chips.find(b => text(b).includes('Answer'))
    assert.ok(answerChip !== undefined && answerChip.className.includes('lc-gran-on'), 'the answer chip is picked')
    const shownRows = queryAll(assistantCat, '.lc-br-elem')
    assert.equal(shownRows.length, 1, 'only the textual reply survives the answer filter')
    assert.ok(text(shownRows[0]).includes('an answer'))
    // The stats card's Skill Loads figure: skill open, no chip picked, lens cleared.
    await m.update(h(Browser, props({
      data,
      onOpenCat,
      catFocus: { cat: 'skill' },
      onCatFocusHandled: () => { handled += 1 },
    })))
    assert.equal(handled, 2)
    assert.deepEqual(opens, [null, 'assistant', 'skill'])
    assert.ok(catRow(m, 'skill').className.includes('lc-br-cat-open'))
    assert.ok(!catRow(m, 'assistant').className.includes('lc-br-cat-open'), 'the previous category closed')
    await m.unmount()
  })
})

