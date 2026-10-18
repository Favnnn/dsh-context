import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { UNKNOWN_TOOL_SOURCE, type ContextHeaders, type HeaderEpochContent } from '../../../src/shared/types'
import { click, flush, mount, query, queryAll, surfaceNode, text, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, pickStep, props, req, settings, tl, typeToolSearch } from './browserHarness'

describe('ContextBrowser tool schemas', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, systemTokens: 3,
      tools: [
        // Producer order is NOT meaningful: rows re-rank by token price.
        { name: 'omega', tokens: 5, plugin: 'mcp:github' },
        { name: 'rho', tokens: 6 },
        { name: 'theta', tokens: 8 },
        { name: 'zeta', tokens: 10 },
        { name: 'epsilon', tokens: 20 },
        { name: 'delta', tokens: 30 },
        { name: 'gamma', tokens: 40 },
        { name: 'beta', tokens: 50 },
        { name: 'mega', tokens: 100 },
      ],
    }],
  }
  const content: HeaderEpochContent = {
    system: 'SYS',
    tools: [
      { name: 'omega', schema: {} },
      { name: 'rho', schema: 'nope' },
      { name: 'theta', schema: { type: 'object', properties: null } },
      { name: 'zeta', schema: { type: 'object' } },
      { name: 'epsilon', schema: { type: 'object', properties: { z: { type: 'integer' } } } },
      { name: 'delta', schema: { parameters: 'junk', input_schema: { properties: { y: { type: 'integer' } } } } },
      { name: 'gamma', schema: { inputSchema: { properties: 'nope' } } },
      { name: 'beta', schema: { input_schema: { properties: { x: { type: 'string' } } } } },
      {
        name: 'mega', description: 'does everything',
        schema: {
          name: 'mega',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'string', description: 'the a param' },
              b: { type: 'object', properties: { x: {}, y: {} } },
              c: { type: 'array', items: { type: 'number' } },
              d: { type: 'array' },
              d2: { type: 'array', items: null },
              e: { type: 'string', enum: ['x', 'y'] },
              e2: { type: 'string', enum: [] },
              f: { enum: [1, 2] },
              g: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              h: { oneOf: [{ type: 'boolean' }] },
              i: { anyOf: [null, { type: 'string' }] },
              j: { anyOf: [] },
              k: { anyOf: [42, null] },
              l: { type: 'object', properties: {} },
              m: { type: 'object', properties: null },
              n: { type: 'object', properties: 42 },
              o: 'not-an-object',
              p: { description: 42 },
              q: { description: '' },
            },
            required: ['a', 42],
          },
        },
      },
    ],
  }
  const data = tl({ current: { system: 10, tools: 248, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 258 } })
  const lazyProps = () => props({ data, headers, fetchHeader: () => Promise.resolve(content) })

  test('rows rank by token price; the schema narrowing matrix renders', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const rows = elemRows(m)
    assert.equal(rows.length, 9)
    assert.deepEqual(rows.map(r => text(query(r, '.lc-br-preview'))),
      ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])

    // mega: the full parameter matrix.
    await click(rows[0])
    const body = query(m.container, '.lc-br-content')
    assert.ok(text(body).includes('does everything'), 'description section renders')
    const paramRows = queryAll(body, '.lc-ts-param-row')
    assert.equal(paramRows.length, 18, 'one row per object-valued property')
    const byName = (n: string) => paramRows.find(r => text(query(r, '.lc-ts-param-name')) === n)
    const typeOf = (n: string) => text(query(byName(n) as HTMLElement, '.lc-ts-param-type'))
    assert.equal(typeOf('a'), 'string')
    assert.equal(typeOf('b'), 'object{2}')
    assert.equal(typeOf('c'), 'array<number>')
    assert.equal(typeOf('d'), 'array')
    assert.equal(typeOf('d2'), 'array')
    assert.equal(typeOf('e'), 'string (enum)')
    assert.equal(typeOf('e2'), 'string')
    assert.equal(typeOf('f'), '(enum)')
    assert.equal(typeOf('g'), 'string | number')
    assert.equal(typeOf('h'), 'boolean')
    assert.equal(typeOf('i'), 'string')
    assert.equal(typeOf('j'), 'unknown')
    assert.equal(typeOf('k'), 'unknown')
    assert.equal(typeOf('l'), 'object')
    assert.equal(typeOf('m'), 'object')
    assert.equal(typeOf('n'), 'object')
    assert.equal(typeOf('p'), 'unknown')
    assert.equal(text(query(byName('a') as HTMLElement, '.lc-ts-param-req')), '✓')
    assert.equal(text(query(byName('b') as HTMLElement, '.lc-ts-param-req-off')), '·')
    assert.ok(text(byName('a') as HTMLElement).includes('the a param'))
    assert.equal(queryAll(byName('p') as HTMLElement, '.lc-ts-param-desc').length, 0, 'non-string description hidden')
    assert.equal(queryAll(byName('q') as HTMLElement, '.lc-ts-param-desc').length, 0, 'empty description hidden')
    assert.ok(text(body).includes('Parameters'))

    const toggle = query(body, '.lc-ts-json-toggle')
    assert.ok(text(toggle).includes('View Raw JSON'))
    await click(toggle)
    assert.ok(text(query(body, '.lc-ts-desc-body')).includes('"parameters"'))
    assert.ok(text(query(body, '.lc-ts-json-toggle')).includes('Collapse'))
    await click(query(body, '.lc-ts-json-toggle'))
    assert.equal(queryAll(body, 'pre').length, 0)
    await click(elemRows(m)[0])
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0)
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a text filter and the size/name sort narrow and re-rank the rows', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by name, description, or parameters…')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.equal(sortBtns.length, 3)
    assert.ok(sortBtns[0].className.includes('lc-gran-on'), 'size is the default sort')
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))

    await typeToolSearch(m, 'gamma')
    assert.deepEqual(names(), ['gamma'])
    // The producer description matches: mega's 'does everything'.
    await typeToolSearch(m, 'everything')
    assert.deepEqual(names(), ['mega'])
    // The parameter JSON matches: 'the a param' lives in mega's schema.
    await typeToolSearch(m, 'the a param')
    assert.deepEqual(names(), ['mega'])
    // The plugin chip matches: omega carries mcp:github.
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 9)

    await click(sortBtns[2])
    assert.ok(sortBtns[2].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    // Count sort with no tool-result nodes on the surface: all tallies tie at zero and break by name.
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[0])
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('count sort ranks by call hits on the shown surface; collapsed rows carry the tally', async () => {
    // Sizes anti-correlate with hits so the count ranking is visibly its own
    // order; delta ties gamma's tally and wins the name tie-break.
    settings.set('defaultToolSort', 'size')
    const hitHeaders: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'alpha', tokens: 100 },
      { name: 'beta', tokens: 10 },
      { name: 'gamma', tokens: 30 },
      { name: 'delta', tokens: 20 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 160, user: 0, inject: 0, skill: 0, assistant: 10, tool: 80, total: 260 },
      requests: [req({ seq: 4, turn: 1, step: 0 })],
      nodes: [
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 10 }),
        surfaceNode({ seq: 3, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 5, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 6, cat: 'tool', tool: 'gamma', tokens: 20 }),
        surfaceNode({ seq: 7, cat: 'tool', tool: 'delta', tokens: 20 }),
        // An unpaired result (no name stamped by the fold) hits nothing.
        surfaceNode({ seq: 8, cat: 'tool', tokens: 20 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: hitHeaders, fetchHeader: () => Promise.resolve({ tools: [] }) })))
    await click(catRow(m, 'tools'))
    await flush()
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const hits = () => elemRows(m).map(r => text(query(r, '.lc-br-hits')))
    // Size default; every collapsed row carries its tally (0 = never called).
    assert.deepEqual(names(), ['alpha', 'gamma', 'delta', 'beta'])
    assert.deepEqual(hits(), ['×0', '×1', '×1', '×2'])
    assert.equal(query(m.container, '.lc-br-hits').title, 'Times this tool was called and answered within the shown step’s context')
    // Count sort: hits desc, ties break by name (delta over gamma).
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    await click(sortBtns[1])
    assert.deepEqual(names(), ['beta', 'delta', 'gamma', 'alpha'])
    assert.deepEqual(hits(), ['×2', '×1', '×1', '×0'])
    // Picking a past step re-tallies over THAT step's assembled surface:
    // only seq < 4 assembles, so beta drops to its one early call; the zero-hit tools order by name.
    await pickStep(m, '4')
    await click(catRow(m, 'tools'))
    await flush()
    assert.deepEqual(names(), ['beta', 'alpha', 'delta', 'gamma'])
    assert.deepEqual(hits(), ['×1', '×0', '×0', '×0'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('the mount-time default tool sort comes from the plugin settings', async () => {
    const pair: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'zzz', tokens: 1 },
      { name: 'aaa', tokens: 100 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 101, user: 0, inject: 0, skill: 0, assistant: 0, tool: 10, total: 121 },
      nodes: [surfaceNode({ seq: 2, cat: 'tool', tool: 'zzz', tokens: 10 })],
    })
    const names = (m: Mounted) => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const sortBtns = (container: ParentNode) => queryAll(container, '.lc-br-toolctl .lc-gran-btn')
    const mountWith = async (sort: string) => {
      settings.set('defaultToolSort', sort)
      const m = await mount(h(Browser, props({ data, headers: pair, fetchHeader: () => Promise.resolve({ tools: [] }) })))
      await click(catRow(m, 'tools'))
      return m
    }

    // The schema default: most call hits first (zzz ×1 over aaa ×0).
    let m = await mountWith('count')
    assert.ok(sortBtns(m.container)[1].className.includes('lc-gran-on'))
    assert.deepEqual(names(m), ['zzz', 'aaa'])
    await m.unmount()

    m = await mountWith('size')
    assert.ok(sortBtns(m.container)[0].className.includes('lc-gran-on'))
    assert.deepEqual(names(m), ['aaa', 'zzz'])
    await m.unmount()

    m = await mountWith('name')
    assert.ok(sortBtns(m.container)[2].className.includes('lc-gran-on'))
    assert.deepEqual(names(m), ['aaa', 'zzz'])
    await m.unmount()

    // In-toolbar toggling never writes the preference back.
    m = await mountWith('count')
    await click(sortBtns(m.container)[0])
    assert.equal(settings.store.getSnapshot().toolSort, 'count')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('before the epoch content loads, the filter scans names and plugins only', async () => {
    const m = await mount(h(Browser, props({ data, headers, fetchHeader: () => new Promise(() => {}) })))
    await click(catRow(m, 'tools'))
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    // The plugin chip is metadata: it matches pre-fetch.
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    // Content-borne text cannot match before the fetch resolves.
    await typeToolSearch(m, 'everything')
    assert.equal(names().length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await m.unmount()
  })

  test('a hostile schema degrades the text filter, not the rows', async () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['self'] = cyclic
    const hostileContent: HeaderEpochContent = {
      system: 'SYS',
      tools: [
        { name: 'loop', schema: cyclic },
        { name: 'nully', schema: null },
        { name: 'plain', schema: {} },
      ],
    }
    const hostile: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'loop', tokens: 3 },
      { name: 'nully', tokens: 1 },
      { name: 'plain', tokens: 2 },
    ] }] }
    const m = await mount(h(Browser, props({ data, headers: hostile, fetchHeader: () => Promise.resolve(hostileContent) })))
    await click(catRow(m, 'tools'))
    await flush()
    assert.equal(elemRows(m).length, 3)
    // The name still matches; the unstringifiable schema contributes no text.
    await typeToolSearch(m, 'loop')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['loop'])
    await typeToolSearch(m, 'properties')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await m.unmount()
  })

  test('schema nesting variants and the empty/degenerate arms', async () => {
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const rows = elemRows(m)
    const open = async (name: string) => {
      const row = rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement
      await click(row)
      return query(m.container, '.lc-br-content')
    }
    const close = async (name: string) => {
      await click(rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement)
    }
    // beta: input_schema nesting, no description.
    let body = await open('beta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    assert.ok(!text(body).includes('Description'), 'no description section without one')
    await close('beta')

    // gamma: inputSchema nesting with non-object properties → params empty.
    body = await open('gamma')
    assert.ok(text(body).includes('(no parameters)'))
    await close('gamma')

    // delta: a non-object `parameters` falls through to input_schema.
    body = await open('delta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    await close('delta')

    // epsilon: bare-root object schema is itself the parameter object.
    body = await open('epsilon')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    assert.ok(text(body).includes('integer'))
    await close('epsilon')

    // zeta: object type without properties → no params section at all.
    body = await open('zeta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 0)
    assert.ok(!text(body).includes('(no parameters)'))
    assert.ok(queryAll(body, '.lc-ts-json-toggle').length === 1, 'raw JSON still available')
    await close('zeta')

    // theta: null properties counts as a (bare) params object with no rows.
    body = await open('theta')
    assert.ok(text(body).includes('(no parameters)'))
    await close('theta')

    // rho: non-object schema → no params, JSON toggle shows the literal.
    body = await open('rho')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 0)
    await click(query(body, '.lc-ts-json-toggle'))
    assert.ok(text(query(body, 'pre')).includes('"nope"'))
    await close('rho')

    // omega: the fetched raw entry carries no description and a bare schema — only the JSON toggle renders behind the row.
    body = await open('omega')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 0)
    assert.ok(!text(body).includes('does everything'))
    assert.ok(queryAll(body, '.lc-ts-json-toggle').length === 1)
    await m.unmount()
  })

  test('a metadata row missing from the fetched content degrades to the not-in-log note', async () => {
    const partial: HeaderEpochContent = { system: 'SYS', tools: [{ name: 'other', schema: {} }] }
    const m = await mount(h(Browser, props({ data, headers, fetchHeader: () => Promise.resolve(partial) })))
    await click(catRow(m, 'tools'))
    await flush()
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'mega') as HTMLElement)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('not in the session log'))
    await m.unmount()
  })

  test('tool rows tag the registering plugin when attribution exists', async () => {
    settings.set('defaultToolSort', 'size')
    const attributed: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'write', tokens: 5, plugin: '@deepseek-ai/dsh-tool-fs' },
        { name: 'mcp__github__get_issue', tokens: 3, plugin: 'mcp:github' },
        { name: 'agent_teams_add_member', tokens: 2 }, // no attribution → no chip
        // Boot-predating tools arrive with the unknown sentinel → localized tag.
        { name: 'claim_files', tokens: 2, plugin: UNKNOWN_TOOL_SOURCE },
      ] }],
    }
    const data = tl({ current: { system: 0, tools: 10, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 } })
    const m = await mount(h(Browser, props({ data, headers: attributed })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    assert.equal(rows.length, 4)
    const chips = queryAll(m.container, '.lc-br-tool-plugin')
    assert.equal(chips.length, 3, 'only attributed tools chip')
    assert.ok(text(chips[0]).includes('@deepseek-ai/dsh-tool-fs'))
    assert.ok(text(chips[1]).includes('mcp:github'))
    assert.ok((chips[0] as HTMLElement).title.includes('The registering plugin of this tool'), 'the chip carries the i18n tooltip')
    assert.ok(!text(rows[2]).includes('@'), 'unattributed tools stay untagged')
    // The unknown-source sentinel renders the localized tag with the boot-timing explanation, never the raw sentinel string.
    assert.equal(chips[2].textContent, 'Unknown plugin')
    assert.ok((chips[2] as HTMLElement).title.includes('registered before the context plugin loaded'), 'unknown chips explain the boot gap')
    // Layout: the tool name leads the row, the plugin chip trails it directly
    // — one frame only, so `lc-br-tag` must not nest another `lc-br-tag`.
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'write', 'tool name leads')
    const chip = chips[0] as HTMLElement
    assert.equal(chip.previousElementSibling, query(rows[0], '.lc-br-preview'), 'plugin chip sits right after the tool name')
    assert.ok(chip.parentElement!.classList.contains('lc-br-elem-row'), 'plugin chip is a single frame, a direct row child')
    assert.equal(queryAll(chip, '.lc-br-tag').length, 0, 'no nested tag wrapper')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a single-tool category opens its schema row with the category; multi stays collapsed', async () => {
    const lone: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'only', tokens: 5 },
      ] }],
    }
    const loneContent: HeaderEpochContent = {
      system: 'SYS',
      tools: [{ name: 'only', schema: { type: 'object', properties: { x: { type: 'string' } } } }],
    }
    const data = tl({ current: { system: 10, tools: 5, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 15 } })
    const m = await mount(h(Browser, props({ data, headers: lone, fetchHeader: () => Promise.resolve(loneContent) })))
    await click(catRow(m, 'tools'))
    await flush()
    assert.equal(elemRows(m).length, 1)
    const content = queryAll(m.container, '.lc-br-content')
    assert.equal(content.length, 1, 'the lone tool schema is already expanded')
    assert.equal(queryAll(content[0], '.lc-ts-param-row').length, 1, 'the schema body renders directly')
    await click(catRow(m, 'tools'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0, 'toggling shut closes the row too')
    await m.unmount()

    const pair: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'a', tokens: 2 }, { name: 'b', tokens: 1 }] }],
    }
    const m2 = await mount(h(Browser, props({ data, headers: pair })))
    await click(catRow(m2, 'tools'))
    assert.equal(elemRows(m2).length, 2)
    assert.equal(queryAll(m2.container, '.lc-br-content').length, 0, 'multi-tool categories open collapsed')
    await m2.unmount()
  })
})

