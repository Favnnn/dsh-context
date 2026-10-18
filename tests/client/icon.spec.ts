// The Context emblem (src/client/icon.tsx): the bundled document sheet behind the right-Sidebar tab type's glyph and
// chip-title seats. Bundled rather than read off the harness primitives, so these specs render the real component; the
// same sheet ships as the package-root icon.svg, pinned in lockstep by a spec here.

import { readFile } from 'node:fs/promises'
import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ContextIcon, makeContextTabTitle } from '../../src/client/icon'
import { makeKit, mount, query, queryAll, text } from './helpers/kit'

describe('ContextIcon', () => {
  test('draws the colourful sheet at the requested edge', async () => {
    const m = await mount(h(ContextIcon, { size: 16, className: 'lc-title-icon' }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 1024 1024')
    assert.equal(svg.getAttribute('class'), 'lc-title-icon')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    // Every stroke carries its own fixed fill — the sheet stays polychrome.
    const paths = queryAll<SVGPathElement>(m.container, 'path')
    assert.equal(paths.length, 10)
    const fills = paths.map(p => p.getAttribute('fill'))
    assert.ok(fills.every(f => typeof f === 'string' && f.startsWith('#')))
    assert.equal(new Set(fills).size, 6, 'the six palette colours all appear')
    await m.unmount()
  })

  test('defaults to a size and can drop the class', async () => {
    const m = await mount(h(ContextIcon, {}))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '20')
    assert.equal(svg.getAttribute('height'), '20')
    assert.equal(svg.getAttribute('class'), null)
    await m.unmount()
  })

  test('the mono seat inks the sheet in the current colour at the harness line weight', async () => {
    const m = await mount(h(ContextIcon, { mono: true }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.innerHTML.match(/fill="#[0-9A-Fa-f]{6}"/g), null, 'no palette fill survives')
    const rects = queryAll<SVGRectElement>(m.container, 'rect')
    assert.equal(
      rects.filter(r => r.getAttribute('fill') === 'currentColor').length,
      1,
      'one current-colour shape carries the whole glyph',
    )
    // The plugin ships one artwork: the drawing appears exactly once, in the
    // complement mask that each eroding shift is painted through.
    assert.equal(queryAll<SVGPathElement>(m.container, 'path').length, 10)
    // The inset itself: a white flood minus one black shift per axis
    // direction, 17 units each — the source's 98-unit bars less the harness weight's 64 makes for two 17s.
    const [hole, thin] = queryAll<SVGMaskElement>(m.container, 'mask')
    assert.match(hole.id, /-hole$/)
    assert.match(thin.id, /-thin$/)
    const shifts = queryAll<SVGRectElement>(thin, 'rect').filter(r => r.getAttribute('fill') === '#000')
    assert.deepEqual(shifts.map(r => r.getAttribute('transform')), [
      'translate(17 0)', 'translate(-17 0)', 'translate(0 17)', 'translate(0 -17)',
    ])
    assert.ok(shifts.every(r => r.getAttribute('mask') === `url(#${hole.id})`))
    await m.unmount()
  })

  test('emblem instances never share mask defs', async () => {
    const a = await mount(h(ContextIcon, { mono: true }))
    const b = await mount(h(ContextIcon, { mono: true }))
    const idsOf = (m: { container: HTMLElement }): string[] =>
      queryAll<SVGMaskElement>(m.container, 'mask').map(mask => mask.id)
    const ids = [...idsOf(a), ...idsOf(b)]
    assert.equal(new Set(ids).size, ids.length, 'a duplicate id would strand one emblem on the other defs')
    await a.unmount()
    await b.unmount()
  })

  test('the package-root icon.svg stays in lockstep with the component', async () => {
    // The static file is what the Host's package-meta reader serves to the
    // Plugins page (package.json `icon`), so a component edit that skips the
    // file — or a manual file edit that skips the component — fails here.
    const raw = await readFile('icon.svg', 'utf8')
    const svgPaths = [...raw.matchAll(/<path d="([^"]+)" fill="([^"]+)"\/>/g)].map(([, d, fill]) => ({ d, fill }))
    const m = await mount(h(ContextIcon, {}))
    const componentPaths = queryAll<SVGPathElement>(m.container, 'path').map(p => ({
      d: p.getAttribute('d'),
      fill: p.getAttribute('fill'),
    }))
    await m.unmount()
    assert.ok(svgPaths.length >= 10)
    assert.deepEqual(svgPaths, componentPaths)
    assert.match(raw, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024">/)
  })
})

describe('makeContextTabTitle — the chip-title seat', () => {
  test('renders the emblem beside the plugin label in the active locale', async () => {
    const { t } = makeKit()
    const Title = makeContextTabTitle(t)
    const m = await mount(h(Title))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    const label = query<HTMLSpanElement>(m.container, '.lc-title-label')
    assert.equal(text(label), 'Context')
    await m.unmount()
  })

  test('follows the bound translate at render (zh label)', async () => {
    const Title = makeContextTabTitle(makeKit('zh').t)
    const m = await mount(h(Title))
    assert.equal(text(m.container), '上下文')
    await m.unmount()
  })
})
