import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextBrowserProps } from '../../../src/client/components/browser'
import type { ContextHeaders } from '../../../src/shared/types'
import type { ConversationNodeLike, ImageLoader } from '../../../src/client/services'
import { click, flush, mount, query, queryAll, surfaceNode, text } from '../helpers/kit'
import { Browser, catRow, elemRows, kit, props, tl, typeToolSearch } from './browserHarness'

describe('ContextBrowser message categories', () => {
  // One rich live surface exercising every NodeContent/BlocksBody branch.
  const convNodes: ConversationNodeLike[] = [
    // user with two images then text (image group flush mid-loop + trailing)
    { kind: 'user', seq: 1, content: [
      { type: 'image', attachment: { attachmentId: 'a1', name: 'one.png', bytes: 2048, width: 100, height: 50 } },
      { type: 'image', attachment: { attachmentId: 'a2' } },
      { type: 'text', text: 'with images' },
    ] },
    // user with text then one image
    { kind: 'user', seq: 2, content: [
      { type: 'text', text: 'one pic' },
      { kind: 'image', attachment: { attachmentId: 'a3' } },
    ] },
    // user without a content array → hint fallback
    { kind: 'user', seq: 5 },
    // assistant full block cascade
    { kind: 'assistant', seq: 68, blocks: [
      { kind: 'text', text: 'final answer' },
      { type: 'reasoning', text: 'thinking hard' },
      { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls","timeout":30,"opts":{"a":1}}' },
      { kind: 'tool-call', name: 'broken', argsRaw: 'not json' },
      { type: 'tool-call', arguments: '{"file_path":"x.ts"}' },
      { kind: 'tool-call', name: 'noargs' },
      { type: 'tool-result', content: [
        { type: 'text', text: 'inner result' },
        { type: 'image', attachment: { attachmentId: 'b1' } },
      ] },
      { type: 'tool-result', content: 'not-an-array' },
      { kind: 'image', attachment: { attachmentId: 'b2', name: 'pic.png', bytes: 4096, width: 640, height: 480 } },
      { type: 'mystery', foo: 1 },
      { type: 'text', text: 42 },
      { kind: 'reasoning', text: 42 },
      'plain string block',
      { foo: 'bar' },
    ] },
    // assistant without blocks but with content (legacy shape)
    { kind: 'assistant', seq: 67, content: [{ type: 'text', text: 'legacy body' }] },
    // assistant summary sources
    { kind: 'assistant', seq: 62, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
    { kind: 'assistant', seq: 63, blocks: [{ kind: 'tool-call', name: 'read', argsRaw: '{}' }] },
    { kind: 'assistant', seq: 64, blocks: [{ kind: 'tool-call', name: 'edit', argsRaw: '{"path":"b.ts"}' }] },
    // compaction nodes
    { kind: 'compaction', seq: 70, summary: 'SUMMARY BODY' },
    { kind: 'compaction', seq: 71, summary: null },
    { kind: 'compaction', seq: 72, summary: '' },
    // inject join
    { kind: 'user', seq: 54, content: [{ type: 'text', text: 'relay body full' }] },
  ]

  const data = tl({
    current: { system: 0, tools: 0, user: 40, inject: 20, skill: 0, assistant: 60, tool: 30, total: 150 },
    nodes: [
      surfaceNode({ seq: 1, tokens: 10, text: 'with images', time: 100 }),
      surfaceNode({ seq: 2, tokens: 9, text: 'one pic', time: 200 }),
      surfaceNode({ seq: 3, tokens: 5, text: 'fallback text', time: 300 }),
      surfaceNode({ seq: 4, tokens: 4, text: '', time: 400 }),
      surfaceNode({ seq: 5, tokens: 4, text: 'no content array', time: 500 }),
      surfaceNode({ seq: 50, cat: 'inject', tokens: 5, form: 'snapshot', text: 'state' }),
      surfaceNode({ seq: 51, cat: 'inject', tokens: 5, form: 'notice', text: 'heads up' }),
      surfaceNode({ seq: 55, cat: 'inject', tokens: 5, form: 'notice', text: '' }),
      surfaceNode({ seq: 56, cat: 'inject', tokens: 5, text: 'no form' }),
      surfaceNode({ seq: 54, cat: 'inject', tokens: 5, form: 'relay', text: 'relay body' }),
      surfaceNode({ seq: 61, cat: 'assistant', tokens: 8, calls: ['bash', 'write'], text: 'done all' }),
      surfaceNode({ seq: 62, cat: 'assistant', tokens: 8, calls: ['write'] }),
      surfaceNode({ seq: 63, cat: 'assistant', tokens: 8, calls: ['read'] }),
      surfaceNode({ seq: 64, cat: 'assistant', tokens: 8 }),
      surfaceNode({ seq: 65, cat: 'assistant', tokens: 8 }),
      surfaceNode({ seq: 66, cat: 'assistant', tokens: 8, calls: [], text: 'plain text' }),
      surfaceNode({ seq: 67, cat: 'assistant', tokens: 8, text: 'legacy' }),
      surfaceNode({ seq: 68, cat: 'assistant', tokens: 20, text: 'full cascade' }),
      surfaceNode({ seq: 70, tokens: 6, text: 'summary node' }),
      surfaceNode({ seq: 71, tokens: 6, text: '' }),
      surfaceNode({ seq: 72, tokens: 6, text: 'empty summary' }),
    ],
  })

  const loadImage: ImageLoader = async (att) => {
    if (att.attachmentId === 'a3' || att.attachmentId === 'b1') throw new Error('denied')
    return 'blob:' + att.attachmentId
  }

  const mountBrowser = async (over: Partial<ContextBrowserProps> = {}) =>
    mount(h(Browser, props({ data, convNodes, loadImage, ...over })))

  test('user rows: image chips on collapsed rows, join content, fallbacks', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    assert.equal(rows.length, 8, 'user + compaction nodes, newest first')
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'empty summary')
    // Attachment chips ride the collapsed row (seq 1 ×2 images, seq 2 ×1).
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    assert.ok(text(rowOf('with images')).includes('Attachments ×2'))
    assert.ok(text(rowOf('one pic')).includes('Attachments'))
    assert.ok(!text(rowOf('one pic')).includes('×'))
    // Open seq 1: the chip makes way for the grid; loader resolves two cards.
    await click(rowOf('with images'))
    await flush()
    let content = query(m.container, '.lc-br-content')
    assert.ok(!text(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement).includes('Attachments ×2'),
      'expanded row drops the chip')
    assert.ok(text(content).includes('Attachments'))
    const imgs = queryAll<HTMLImageElement>(content, '.lc-att-thumb img')
    assert.equal(imgs.length, 2, 'both loads resolved')
    assert.ok(imgs[0].src.includes('blob:a1'))
    assert.ok(text(content).includes('one.png'))
    assert.ok(text(content).includes('100×50'))
    await click(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement)

    // Open seq 2: single image, load REJECTS → error placeholder.
    await click(rowOf('one pic'))
    await flush()
    content = query(m.container, '.lc-br-content')
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.ok(text(query(content, '.lc-att-err')).includes('⚠'))
    await click(elemRows(m).find(r => text(r).includes('one pic')) as HTMLElement)

    // Join missed with preview text: content section + the window note.
    await click(rowOf('fallback text'))
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('fallback text'))
    assert.ok(text(content).includes('outside the loaded message window'))
    await click(elemRows(m).find(r => text(r).includes('fallback text')) as HTMLElement)

    // Join missed without text (seq 4, rows newest-first: 72,71,70,5,4,…): the note alone.
    assert.ok(text(rows[4]).includes('(non-text message)'))
    await click(rows[4])
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    assert.ok(!text(content).includes('Content'))
    await m.unmount()
  })

  test('user node whose conversation entry carries no content array shows the note', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    await click(elemRows(m).find(r => text(r).includes('no content array')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    await m.unmount()
  })

  test('a single-node category opens its node with the category', async () => {
    const solo = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      nodes: [surfaceNode({ seq: 1, tokens: 10, text: 'only message', time: 100 })],
    })
    const m = await mount(h(Browser, props({
      data: solo,
      convNodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'only message' }] }],
    })))
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1)
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1, 'the lone node is already expanded')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('only message'))
    await m.unmount()
  })

  test('message rows filter by tag and preview text; another category opens unfiltered', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by message text…')
    const previews = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    await typeToolSearch(m, 'summary')
    assert.deepEqual(previews(), ['empty summary', 'summary node'])
    // No match keeps the toolbar mounted so the filter can be cleared.
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No rows match the current filter'))
    assert.equal(queryAll(m.container, '.lc-br-tool-search').length, 1)
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 8)

    // The call-breadcrumb tag matches too — both the fold's stamp ('bash › write')
    // and the join-recovered breadcrumb on a mixed text+calls reply.
    await click(catRow(m, 'assistant'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '', 'another category opens unfiltered')
    await typeToolSearch(m, 'bash')
    assert.deepEqual(previews(), ['full cascade', 'done all'])
    await m.unmount()
  })

  test('assistant kind chips: per-kind counts, click filters, re-click clears, switch resets', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const toolctl = query(m.container, '.lc-br-toolctl')
    assert.equal(queryAll(m.container, '.lc-br-toolctl .lc-gran').length, 1, 'only the assistant toolbar carries the kind group')
    assert.equal(query(toolctl, '.lc-gran').getAttribute('title'), kit.t('browser.kindTip'))
    assert.equal(query<HTMLInputElement>(toolctl, '.lc-br-tool-search').placeholder, 'Filter by reply, calls, or thinking…')
    const chips = () => queryAll<HTMLButtonElement>(m.container, '.lc-br-toolctl .lc-gran-btn')
    // Counts over ALL of the shown step's rows: thinking rides the join's
    // reasoning block (seq 68), tools the joined calls (62/63/64/68) plus the
    // unjoined node's `calls` stamp (61), answers the joined text blocks plus the nodes' own text (61/66/67/68).
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'])
    const previews = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.equal(elemRows(m).length, 8)

    await click(chips()[1])
    assert.ok(chips()[1].className.includes('lc-gran-on'))
    assert.deepEqual(previews(), ['full cascade', 'b.ts', '(empty reply)', 'a.ts', 'done all'])
    // The counts report the step's composition — the text lens narrows on top of them.
    await typeToolSearch(m, 'done')
    assert.deepEqual(previews(), ['done all'])
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'])
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(query(m.container, '.lc-br-body')).includes('No rows match the current filter'))
    assert.equal(chips().length, 3, 'the chips stay mounted on an empty match')
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 5)

    await click(chips()[1])
    assert.equal(elemRows(m).length, 8)
    await click(chips()[0])
    assert.deepEqual(previews(), ['full cascade'])
    await click(chips()[2])
    assert.ok(chips()[2].className.includes('lc-gran-on'))
    assert.ok(!chips()[0].className.includes('lc-gran-on'), 'the kinds are exclusive')
    assert.deepEqual(previews(), ['full cascade', 'legacy', 'Calls ', 'done all'])

    await click(catRow(m, 'user'))
    assert.equal(queryAll(m.container, '.lc-br-toolctl .lc-gran-btn').length, 0)
    await click(catRow(m, 'assistant'))
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'])
    assert.ok(chips().every(c => !c.className.includes('lc-gran-on')))
    assert.equal(elemRows(m).length, 8)
    await m.unmount()
  })

  test('call-name capsules and heads are inert: a click never reveals the schema row', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'bash', tokens: 5 }, { name: 'write', tokens: 3 }] }] }
    const m = await mountBrowser({ headers })
    await click(catRow(m, 'assistant'))
    // The breadcrumb capsule is plain text on the row button: a click bubbles to the row's own toggle —
    // the row opens and nothing navigates to Tool Schemas.
    const crumbRow = elemRows(m).find(r => text(r).includes('done all')) as HTMLElement
    await click(query(crumbRow, '.lc-br-tag'))
    assert.ok(!text(query(m.container, '.lc-br-cat-open')).includes('Tool Schemas'), 'no category jump')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('done all'), 'the row toggle fired')
    const cascade = elemRows(m).find(r => text(r).includes('full cascade')) as HTMLElement
    await click(cascade)
    const head = queryAll(m.container, '.lc-ts-card-head b').find(el => text(el) === '→ bash') as HTMLElement
    await click(head)
    assert.ok(!text(query(m.container, '.lc-br-cat-open')).includes('Tool Schemas'), 'no category jump')
    const on = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(on.length, 1)
    assert.ok(text(on[0]).includes('full cascade'), 'the open row never moved')
    await m.unmount()
  })

  test('repeated call names fold into ×N capsules in first-appearance order', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'bash', tokens: 5 }, { name: 'write', tokens: 3 }] }] }
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 8, tool: 0, total: 8 },
      nodes: [surfaceNode({ seq: 2, cat: 'assistant', tokens: 8, calls: ['bash', 'write', 'bash', 'bash'] })],
    })
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'assistant'))
    // 'bash › write › bash › bash' groups into two capsules: the repeat multiplier keeps the first-appearance order.
    const row = elemRows(m)[0]
    const caps = queryAll(row, '.lc-br-tag')
    assert.deepEqual(caps.map(c => text(c)), ['bash ×3', 'write'])
    await m.unmount()
  })

  test('the assistant text filter scans the join’s reasoning blocks', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    // 'thinking hard' rides seq 68's reasoning block — no tag, preview, or node text carries it.
    await typeToolSearch(m, 'thinking hard')
    const rows = elemRows(m)
    assert.equal(rows.length, 1)
    assert.ok(text(rows[0]).includes('full cascade'))
    // A malformed reasoning block (non-string text) drops from the scan whole — its value matches nothing.
    await typeToolSearch(m, '42')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(query(m.container, '.lc-br-body')).includes('No rows match the current filter'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 8)
    await m.unmount()
  })

  test('user images render a placeholder when no loader is wired', async () => {
    const m = await mountBrowser({ loadImage: undefined })
    await click(catRow(m, 'user'))
    await click(elemRows(m).find(r => text(r).includes('one pic')) as HTMLElement)
    assert.equal(queryAll(m.container, '.lc-att-ph').length, 1)
    await m.unmount()
  })

  test('assistant rows: preview cascade and the full block vocabulary', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const rows = elemRows(m)
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    const capsOf = (row: HTMLElement) => queryAll(row, '.lc-br-tag').map(c => text(c))
    assert.deepEqual(capsOf(rowOf('done all')), ['bash', 'write'], 'call breadcrumb: one capsule per distinct call')
    assert.ok(capsOf(rowOf('a.ts')).includes('write'), 'block summary previews a textless turn')
    const tags = rows.map(r => {
      const caps = capsOf(r)
      const preview = text(query(r, '.lc-br-preview'))
      return `${caps.length === 0 ? '∅' : caps.join(',')}$|${preview}`
    })
    assert.ok(tags.includes('read$|(empty reply)'), 'no self-summarizing call → empty marker')
    assert.ok(tags.includes('edit$|b.ts'), 'a textless turn tags the joined call name and previews its summary')
    assert.ok(tags.includes('bash,broken,noargs$|full cascade'), 'a mixed reply tags one capsule per join-recovered call, in order')
    assert.ok(tags.includes('∅$|(empty reply)'), 'no join, no calls → empty marker')
    assert.ok(tags.includes('∅$|Calls '), 'empty call list previews as a bare Calls label (nodeText)')

    await click(rowOf('full cascade'))
    const content = query(m.container, '.lc-br-content')
    const heads = queryAll(content, '.lc-ts-card-head').map(el => text(el))
    assert.ok(heads.some(s => s.includes('Answer')))
    assert.ok(heads.some(s => s.includes('Reasoning')))
    assert.ok(heads.some(s => s.includes('→ bash')))
    assert.ok(heads.some(s => s.includes('→ broken')))
    assert.ok(heads.some(s => s.includes('→ ?')), 'nameless call card')
    assert.ok(heads.some(s => s.includes('→ noargs')))
    assert.ok(heads.some(s => s.includes('Result')), 'nested tool-result text section')
    assert.ok(heads.filter(s => s.includes('Other content')).length === 6, 'unknown blocks render raw JSON')
    assert.ok(heads.some(s => s.includes('Attachments')))
    const argVals = queryAll(content, '.lc-ts-arg-row').map(el => text(el))
    assert.ok(argVals.some(s => s.includes('command') && s.includes('ls')))
    assert.ok(argVals.some(s => s.includes('timeout') && s.includes('30')))
    assert.ok(argVals.some(s => s.includes('opts') && s.includes('{"a":1}')))
    // Unparseable args show raw; absent args show nothing.
    assert.ok(text(content).includes('not json'))
    assert.ok(text(content).includes('inner result'))
    await flush()
    // b1 rejects (error), b2 resolves.
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.equal(queryAll(content, '.lc-att-thumb img').length, 1)
    await m.unmount()
  })

  test('assistant with a legacy content array renders the generic content section', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    await click(elemRows(m).find(r => text(r).includes('legacy')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('Content'))
    assert.ok(text(content).includes('legacy body'))
    await m.unmount()
  })

  test('assistant without a join shows only the window note', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const row = elemRows(m).find(r => text(r).includes('(empty reply)') && !text(r).includes('read')) as HTMLElement
    await click(row)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    await m.unmount()
  })

  test('compaction nodes: summary text, null and empty summaries', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    // Newest first: 72 (empty summary), 71 (null summary), 70 (summary node).
    await click(rows[2])
    let content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('Summary'))
    assert.ok(text(content).includes('SUMMARY BODY'))
    // Null summary → empty body.
    await click(rows[1])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    // Empty-string summary → empty body.
    await click(rows[0])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    await m.unmount()
  })

  test('inject rows: form tags, snapshot prefix, skill injects', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'inject'))
    const rows = elemRows(m)
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('State Snapshot|Snapshot: state'))
    assert.ok(tags.includes('Notice|heads up'))
    assert.ok(tags.includes('Notice|Notice'), 'empty-string text keeps the form label')
    assert.ok(tags.includes('Context Injection|no form'), 'formless inject defaults to the context label')
    assert.ok(tags.includes('Agent Relay|relay body'))
    await click(rows.find(r => text(r).includes('relay body')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('relay body full'))
    await m.unmount()
  })

  test('inject rows label the fold-stamped source identity; the folded text stays filterable', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 45, skill: 0, assistant: 0, tool: 0, total: 45 },
      nodes: [
        // Stamped rows: the identity the events card names replaces the raw content preview (which stays one expand away).
        surfaceNode({ seq: 50, cat: 'inject', tokens: 9, form: 'snapshot', name: '@deepseek-ai/dsh-system-prompt', text: 'policy sections' }),
        surfaceNode({ seq: 51, cat: 'inject', tokens: 9, form: 'instructions', name: 'AGENTS.md', text: '<system-reminder> instructions' }),
        // Unstamped (rows folded before the stamp existed): content stands.
        surfaceNode({ seq: 52, cat: 'inject', tokens: 9, form: 'snapshot', text: 'state' }),
        // Hostile drift: a non-string / empty stamp degrades to the content.
        surfaceNode({ seq: 53, cat: 'inject', tokens: 9, name: 42 as never, text: 'drift body' }),
        surfaceNode({ seq: 54, cat: 'inject', tokens: 9, name: '', text: 'empty body' }),
      ],
    })
    const m = await mount(h(Browser, props({ data })))
    await click(catRow(m, 'inject'))
    const tags = elemRows(m).map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('State Snapshot|@deepseek-ai/dsh-system-prompt'))
    assert.ok(tags.includes('Instructions|AGENTS.md'))
    assert.ok(tags.includes('State Snapshot|Snapshot: state'))
    assert.ok(tags.includes('Context Injection|drift body'))
    assert.ok(tags.includes('Context Injection|empty body'))
    // The folded content left the preview but stays in the filter's lens.
    await typeToolSearch(m, 'policy sections')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['@deepseek-ai/dsh-system-prompt'])
    await typeToolSearch(m, 'AGENTS.md')
    assert.equal(elemRows(m).length, 1)
    await m.unmount()
  })

  test('skill rows: loads/invocations name themselves, the catalog tags its form', async () => {
    const convNodes: ConversationNodeLike[] = [
      { kind: 'tool-result', seq: 72, call: { name: 'skill', argsRaw: '{"description":"grill the plan"}' }, content: [{ type: 'text', text: 'skill body' }] },
    ]
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 40, assistant: 0, tool: 0, total: 40 },
      nodes: [
        // An invocation message previews its own text; the catalog digest tags
        // its form; the `skill`-tool load (no node text) previews the call.
        surfaceNode({ seq: 70, cat: 'skill', tokens: 9, skill: 'code-review', text: 'skill body' }),
        surfaceNode({ seq: 71, cat: 'skill', tokens: 9, form: 'catalog' }),
        surfaceNode({ seq: 72, cat: 'skill', tokens: 9, tool: 'skill', skill: 'grilling' }),
        // Hostile drift: a skill node with neither a name nor a form.
        surfaceNode({ seq: 73, cat: 'skill', tokens: 4 }),
        // A stamped catalog digest previews its source identity, not the digest text.
        surfaceNode({ seq: 74, cat: 'skill', tokens: 9, form: 'catalog', name: 'skill-catalog', text: 'digest body' }),
      ],
    })
    const m = await mount(h(Browser, props({ data, convNodes })))
    assert.ok(text(catRow(m, 'skill')).includes('Skill Injections'))
    assert.ok(text(catRow(m, 'skill')).includes('5 Items'))
    await click(catRow(m, 'skill'))
    const rows = elemRows(m)
    assert.equal(rows.length, 5)
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('Skill · code-review|skill body'), 'the invocation names itself and previews its text')
    assert.ok(tags.includes('Catalog Update|Catalog Update'), 'the textless catalog digest tags its form')
    assert.ok(tags.includes('Skill · grilling|grill the plan'), 'the load previews its call summary')
    assert.ok(tags.includes('Context Injection|Context Injection'), 'a nameless, formless skill row degrades to the context label')
    assert.ok(tags.includes('Catalog Update|skill-catalog'), 'a stamped catalog digest previews its source identity')
    await m.unmount()
  })
})

