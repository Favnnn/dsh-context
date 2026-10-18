import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextBrowserProps } from '../../../src/client/components/browser'
import type { ContextHeaders } from '../../../src/shared/types'
import { click, focus, hover, mount, pinRect, query, queryAll, surfaceNode, text, tipRows, unhover, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, props, tl } from './browserHarness'

/** The map fixtures lay out on the panel's jsdom fallback canvas (640×240) — jsdom never sizes the wrap. */
const mapHeaders: ContextHeaders = {
  headers: [{ seq: 1, time: 1000, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 25 }] }],
}

function mapData(): ReturnType<typeof tl> {
  return tl({
    current: { system: 100, tools: 75, user: 20, inject: 10, skill: 0, assistant: 40, tool: 300, total: 545 },
    nodes: [
      surfaceNode({ seq: 2, tokens: 20, time: 2000, text: 'hi' }),
      surfaceNode({ seq: 3, cat: 'tool', tokens: 180, tool: 'bash' }),
      surfaceNode({ seq: 4, cat: 'tool', tokens: 120, tool: 'bash' }),
      surfaceNode({ seq: 5, cat: 'assistant', tokens: 40, text: 'ok' }),
      surfaceNode({ seq: 6, cat: 'inject', tokens: 10, form: 'notice' }),
    ],
  })
}

function mapBtn(m: Mounted): HTMLElement {
  return query(m.container, '.lc-br-map-btn')
}

function regions(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-map-cat')
}

function blocks(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-map-block')
}

function blockByText(m: Mounted, txt: string): HTMLElement {
  const found = blocks(m).find(b => text(b).includes(txt))
  assert.ok(found !== undefined, `a block carrying "${txt}"`)
  return found
}

function regionByHead(m: Mounted, label: string): HTMLElement {
  const found = regions(m).find(r => queryAll(r, '.lc-map-cat-label').some(l => l.textContent === label))
  assert.ok(found !== undefined, `a region headed "${label}"`)
  return found
}

describe('ContextBrowser block map', () => {
  test('the bar-right toggle opens the treemap below the bar and closes it again', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    assert.equal(queryAll(m.container, '.lc-map').length, 0)
    const btn = mapBtn(m)
    assert.equal(btn.getAttribute('aria-label'), 'Toggle the block map')
    assert.equal(btn.getAttribute('aria-pressed'), 'false')
    assert.ok(btn.querySelector('svg') !== null)

    await click(btn)
    assert.equal(btn.getAttribute('aria-pressed'), 'true')
    assert.ok(btn.className.includes('lc-br-map-btn-on'))
    assert.ok(query(m.container, '.lc-map') !== null)
    // Regions in size order: tool results, the system prompt, tool schemas, assistant, user, injections.
    assert.deepEqual(regions(m).map(r => queryAll(r, '.lc-map-cat-label')[0]?.textContent ?? '(no head)'), [
      'Tool Results', 'System Prompt', 'Tool Schemas', 'Assistant Messages', 'User Messages', '(no head)',
    ])

    await click(btn)
    assert.equal(queryAll(m.container, '.lc-map').length, 0)
    assert.equal(btn.getAttribute('aria-pressed'), 'false')
    await m.unmount()
  })

  test('blocks: grouped results carry a ×N fold and a figure, tiny blocks render bare', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    // bash ×2 = the two bash results folded into one block of the tool-results region.
    const bash = blockByText(m, 'bash')
    assert.equal(query(bash, '.lc-map-label').textContent, 'bash×2')
    assert.equal(query(bash, '.lc-map-num').textContent, '≈300')
    // The injections region is too shallow for its figure: label only, no token line.
    const notice = blockByText(m, 'Notice')
    assert.equal(queryAll(notice, '.lc-map-num').length, 0)
    // The system region holds one block naming the prompt itself.
    assert.equal(text(blockByText(m, 'System Prompt')).includes('≈100'), true)
    await m.unmount()
  })

  test('clicking a grouped block opens its category with the rows filtered to the group', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    await click(blockByText(m, 'bash'))
    assert.ok(catRow(m, 'tool').className.includes('lc-br-cat-open'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, 'bash')
    assert.equal(elemRows(m).length, 2)
    // The block's own category region stays framed while the category is open.
    assert.ok(regionByHead(m, 'Tool Results').className.includes('lc-map-cat-open'))
    await m.unmount()
  })

  test('clicking a singleton block opens its exact row', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    await click(blockByText(m, '#2'))
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-open'))
    const on = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(on.length, 1)
    assert.ok(text(on[0]).includes('hi'))
    await m.unmount()
  })

  test('clicking a region header toggles the category like its row does', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    const head = query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head')
    await click(head)
    assert.ok(catRow(m, 'system').className.includes('lc-br-cat-open'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 1)
    await click(head)
    assert.ok(!catRow(m, 'system').className.includes('lc-br-cat-open'))
    await m.unmount()
  })

  test('the “more” fold opens the category without a filter', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 1183, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1183 },
      nodes: Array.from({ length: 13 }, (_, i) => surfaceNode({ seq: i + 1, tokens: 100 - i, text: `m${i}` })),
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(mapBtn(m))
    const more = blockByText(m, '2 more')
    await click(more)
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-open'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '')
    assert.equal(elemRows(m).length, 13)
    await m.unmount()
  })

  test('hover floats the block bubble and reports its category upward; the region head names the whole category', async () => {
    const hovers: (string | null)[] = []
    const Harness = (p2: Omit<ContextBrowserProps, 'hoverKey' | 'onHoverKey'>) => {
      const [hoverKey, setHoverKey] = useState<string | null>(null)
      return h(Browser, props({ ...p2, hoverKey, onHoverKey: (k) => { setHoverKey(k); hovers.push(k) } }))
    }
    const m = await mount(h(Harness, { data: mapData(), headers: mapHeaders }))
    await click(mapBtn(m))

    const bash = blockByText(m, 'bash')
    await hover(bash)
    assert.deepEqual(tipRows(query(m.container, '.lc-map-tip')), ['bash ×2', '≈300 · 55% of used context', null])
    assert.ok(query(m.container, '.lc-map').className.includes('lc-map-dim'))
    assert.ok(bash.className.includes('lc-map-block-on'))
    assert.deepEqual(hovers, ['tool'])

    // Moving to a region head switches the bubble to the whole category.
    const sysHead = query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head')
    await hover(sysHead)
    assert.deepEqual(tipRows(query(m.container, '.lc-map-tip')), ['System Prompt', '≈100 · 18% of used context', '1 Items'])
    assert.deepEqual(hovers, ['tool', 'system'])

    // The incoming shared hover lights the matching region.
    assert.ok(regionByHead(m, 'System Prompt').className.includes('lc-map-cat-on'))
    await unhover(query(m.container, '.lc-map'))
    assert.ok(!query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    assert.deepEqual(hovers, ['tool', 'system', null])
    await m.unmount()
  })

  test('standalone (no shared hover wiring): hovers stay local and keyboard focus floats the bubble too', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    const bash = blockByText(m, 'bash')
    await hover(bash)
    assert.ok(query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    await unhover(query(m.container, '.lc-map'))
    assert.ok(!query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    // A region head hover works standalone as well.
    await hover(query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head'))
    assert.deepEqual(tipRows(query(m.container, '.lc-map-tip'))[0], 'System Prompt')
    await unhover(query(m.container, '.lc-map'))
    await focus(bash)
    assert.ok(query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    await m.unmount()
  })

  test('DNA keeps the map’s link one-way: block hovers stay local while an incoming category key still lights the region', async () => {
    const hovers: (string | null)[] = []
    const wired = (over: Partial<ContextBrowserProps>) => h(Browser, props({
      data: mapData(), headers: mapHeaders, dna: true, onDnaChange: () => {},
      hoverKey: null, onHoverKey: (k) => { hovers.push(k) },
      ...over,
    }))
    const m = await mount(wired({}))
    await click(mapBtn(m))
    await hover(blockByText(m, 'bash'))
    assert.deepEqual(hovers, [], 'the map reports nothing upward in DNA mode')
    assert.ok(query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'), 'the local bubble still works')
    await hover(blockByText(m, '#2'))
    assert.deepEqual(hovers, [])
    // The incoming category mirror still lights the matching region's frame.
    await m.update(wired({ hoverKey: 'tool' }))
    assert.ok(regionByHead(m, 'Tool Results').className.includes('lc-map-cat-on'))
    await m.unmount()
  })

  test('a push removing the hovered block retracts the bubble instead of floating a stale one', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    await hover(blockByText(m, 'bash'))
    assert.ok(query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    const pushed = mapData()
    pushed.nodes = pushed.nodes.filter(n => n.seq !== 3 && n.seq !== 4)
    pushed.current = { ...pushed.current, tool: 0, total: 245 }
    await m.update(h(Browser, props({ data: pushed, headers: mapHeaders })))
    assert.ok(!query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    assert.ok(!query(m.container, '.lc-map').className.includes('lc-map-dim'))
    assert.ok(blocks(m).every(b => !text(b).includes('bash×2')))
    await m.unmount()
  })

  test('the bubble clamps inside the panel: shifted at the edges, centered and unflipped mid-panel', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    const wrap = query(m.container, '.lc-map')
    const tip = query(m.container, '.lc-map-tip')
    pinRect(wrap, 400, 240)
    pinRect(tip, 300)
    await m.update(h(Browser, props({ data: mapData(), headers: mapHeaders })))

    // Leftmost block: the bubble overhangs the left edge and is shifted right.
    await hover(blockByText(m, 'bash'))
    assert.ok(/translateX\(calc\(-50% \+ \d+px\)\)/.test(tip.style.transform), `left-clamped: ${tip.style.transform}`)
    // The rightmost region's block (too small for text): shifted left instead.
    const rightmost = regions(m).reduce((a, b) => (parseFloat(a.style.left) > parseFloat(b.style.left) ? a : b))
    await hover(query(rightmost, '.lc-map-block'))
    assert.ok(/translateX\(calc\(-50% - \d+px\)\)/.test(tip.style.transform), `right-clamped: ${tip.style.transform}`)
    // Dropping the hover while shifted resets the shift along with the bubble.
    await unhover(wrap)
    assert.equal(tip.style.transform, '')
    // A mid-panel block with a narrower bubble fits: no shift, and far enough from the top to hang ABOVE its block.
    pinRect(tip, 60)
    await hover(blockByText(m, '#5'))
    assert.equal(tip.style.transform, 'translateX(-50%) translateY(-100%)')
    await unhover(wrap)
    assert.equal(tip.style.transform, '')
    await m.unmount()
  })

  test('degenerate regions: a sliver category renders a bare frame, a sub-minimum one drops out', async () => {
    const frame = tl({
      current: { system: 10000, tools: 0, user: 190, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10190 },
      systems: [{ seq: 1, time: 1, tokens: 10000 }],
      nodes: [surfaceNode({ seq: 2, tokens: 190 })],
    })
    const m = await mount(h(Browser, props({ data: frame, headers: null })))
    await click(mapBtn(m))
    assert.equal(regions(m).length, 2)
    const sliver = regions(m)[1]
    assert.equal(queryAll(sliver, '.lc-map-cat-head').length, 0)
    assert.equal(queryAll(sliver, '.lc-map-block').length, 0)

    const gone = tl({
      current: { system: 100000, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100010 },
      systems: [{ seq: 1, time: 1, tokens: 100000 }],
      nodes: [surfaceNode({ seq: 2, tokens: 10 })],
    })
    await m.update(h(Browser, props({ data: gone, headers: null })))
    assert.equal(regions(m).length, 1)
    await m.unmount()
  })

  test('a sub-minimum block inside a region is dropped rather than rendered sub-pixel', async () => {
    const data = tl({
      current: { system: 200, tools: 41, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 241 },
      systems: [{ seq: 1, time: 1, tokens: 200 }],
    })
    const headers: ContextHeaders = {
      headers: [{ seq: 1, time: 1000, systemTokens: 200, tools: [{ name: 'bash', tokens: 40 }, { name: 'tiny', tokens: 1 }] }],
    }
    const m = await mount(h(Browser, props({ data, headers })))
    await click(mapBtn(m))
    const toolsRegion = regionByHead(m, 'Tool Schemas')
    const toolsBlocks = queryAll(toolsRegion, '.lc-map-block')
    assert.equal(toolsBlocks.length, 1, 'the 1-token schema sliver drops out')
    assert.ok(text(toolsBlocks[0]).includes('bash'))
    await m.unmount()
  })

  test('an empty step maps to the empty note', async () => {
    const m = await mount(h(Browser, props({ data: tl({}), headers: null })))
    await click(mapBtn(m))
    assert.equal(text(query(m.container, '.lc-map-empty')), 'Nothing to map — this step’s context is empty')
    await m.unmount()
  })
})
