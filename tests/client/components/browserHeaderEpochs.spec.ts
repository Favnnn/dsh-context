import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextHeaders, HeaderEpochContent } from '../../../src/shared/types'
import { headersOf } from '../../../src/client/services'
import { click, flush, mount, query, queryAll, text } from '../helpers/kit'
import { Browser, catRow, elemRows, kit, pickStep, props, req, silenceFetchWarn, tl, withEpochContent } from './browserHarness'

describe('ContextBrowser header epochs', () => {
  const HEADERS: ContextHeaders = {
    headers: [
      { seq: 15, time: 1500, systemTokens: 8, tools: [{ name: 'old', tokens: 1 }] },
      { seq: 35, time: 3500, systemTokens: 12, tools: [{ name: 'fresh', tokens: 9 }] },
    ],
  }
  const CONTENTS: Record<number, HeaderEpochContent> = {
    15: { system: 'SYS A', tools: [{ name: 'old', schema: {} }] },
    35: { system: 'SYS B\nsecond line', tools: [{ name: 'fresh', description: 'fresh tool', schema: {} }] },
  }
  const lazy = withEpochContent(HEADERS, CONTENTS)

  test('system category opens its prompt row directly; rich switch toggles raw/markdown', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await click(catRow(m, 'system'))
    await flush()
    const body = query(m.container, '.lc-br-body')
    assert.ok(text(body).includes('SYS B'), 'the newest epoch’s prompt shows on the live surface')
    assert.ok(text(body).includes('2 lines'), 'line count rides the section head')
    assert.ok(catRow(m, 'system').className.includes('lc-br-cat-open'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1)
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown view by default')
    // Scope to the detail body: the header's own granularity toggles wear the same shared lc-gran classes.
    const rawBtn = queryAll(body, '.lc-gran-btn')[0]
    assert.equal(text(rawBtn), 'Raw')
    await click(rawBtn)
    const lines = queryAll(m.container, '.lc-ts-line').map(line => line.textContent)
    assert.deepEqual(lines, ['SYS B', 'second line'])
    await click(queryAll(body, '.lc-gran-btn')[1])
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown restored')
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    assert.ok(!catRow(m, 'system').className.includes('lc-br-cat-open'))
    await m.unmount()
  })

  test('a past step reads the epoch in force at its seq', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'), 'epoch before the request applies')
    await m.unmount()
  })

  test('an epoch fetches once and the content stays cached across steps', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    let calls = 0
    const counting = { ...lazy, fetchHeader: (seq: number) => { calls += 1; return lazy.fetchHeader(seq) } }
    const m = await mount(h(Browser, props({ data, ...counting })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'))
    assert.equal(calls, 1)
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    assert.equal(calls, 2)
    // Re-opening the first epoch's section hits the cache, not the fetcher.
    await pickStep(m, 'live')
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'))
    assert.equal(calls, 2)
    await m.unmount()
  })

  test('a failed epoch fetch arms the retry button; retrying succeeds', async () => {
    silenceFetchWarn()
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const pendings: Array<{ resolve: (v: HeaderEpochContent | null) => void; reject: (e: unknown) => void }> = []
    const deferred: () => Promise<HeaderEpochContent | null> = () =>
      new Promise((resolve, reject) => { pendings.push({ resolve, reject }) })
    const m = await mount(h(Browser, props({ data, headers: HEADERS, fetchHeader: deferred })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('Loading'), 'the fetch is in flight')
    await act(async () => { pendings[0]!.reject(new Error('down')) })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('Load failed'), 'a rejected read arms the retry')
    await click(query(m.container, '.lc-br-retry'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('Loading'), 'the retry refetches')
    await act(async () => { pendings[1]!.resolve(CONTENTS[35]!) })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'), 'the retried read renders')
    await m.unmount()
  })

  test('a stale epoch fetch resolves and rejects ignored once another epoch takes over', async () => {
    silenceFetchWarn()
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    const pendings: Array<{ resolve: (v: HeaderEpochContent | null) => void; reject: (e: unknown) => void }> = []
    const deferred = (): Promise<HeaderEpochContent | null> =>
      new Promise((resolve, reject) => { pendings.push({ resolve, reject }) })
    const m = await mount(h(Browser, props({ data, headers: HEADERS, fetchHeader: deferred })))
    // Epoch 35's fetch is in flight; picking step 20 re-arms for epoch 15.
    await click(catRow(m, 'system'))
    await flush()
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 2)
    // The stale epoch REJECTS first — ignored: no retry button, still loading epoch 15.
    await act(async () => { pendings[0]!.reject(new Error('stale')) })
    await flush()
    assert.ok(!text(m.container).includes('Load failed'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('Loading'))
    await act(async () => { pendings[1]!.resolve(CONTENTS[15]!) })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    // Back to live: epoch 35's fetch is in flight; the cached epoch 15 renders
    // without a fetch — then the stale resolve lands, ignored.
    await pickStep(m, 'live')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 3)
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 3, 'epoch 15 is cached')
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    await act(async () => { pendings[2]!.resolve(CONTENTS[35]!) })
    await flush()
    assert.ok(!text(m.container).includes('SYS B'), 'the stale content is ignored')
    await m.unmount()
  })

  test('an epoch missing from the durable log degrades to the not-in-log note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({
      data, headers: HEADERS, fetchHeader: () => Promise.resolve(null),
    })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('not in the session log'))
    await click(catRow(m, 'tools'))
    await flush()
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('not in the session log'))
    await m.unmount()
  })

  test('a host without the history face degrades to the metadata-only note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, headers: HEADERS })))
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('token estimates only'))
    await click(catRow(m, 'tools'))
    assert.equal(elemRows(m).length, 1, 'metadata rows still render')
    // The lone metadata row auto-opens with the category; its body explains the degradation.
    assert.ok(text(query(m.container, '.lc-br-content')).includes('token estimates only'))
    await m.unmount()
  })

  test('absent headers projection degrades to the tokens-only note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('older plugin build'))
    await click(catRow(m, 'tools'))
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('older plugin build'))
    await m.unmount()
  })

  test('an epoch outside retention degrades to the no-epoch note', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 10, turn: 1, step: 0 })],
    })
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await pickStep(m, '10')
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('outside retention'))
    await click(catRow(m, 'tools'))
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('outside retention'))
    await m.unmount()
  })

  test('an epoch without a system prompt keeps the system category shut', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, tools: [{ name: 'x', tokens: 1 }] }] }
    const data = tl({ current: { system: 0, tools: 1, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } })
    const m = await mount(h(Browser, props({ data, ...withEpochContent(headers, { 1: { tools: [] } }) })))
    assert.ok(text(catRow(m, 'system')).includes('0 Items'))
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'no prompt, no body')
    await m.unmount()
  })

  test('a legacy content-bearing epoch (pre-#37 wire) still counts the system prompt', async () => {
    // The value shape a host running the pre-#37 view serves: the system TEXT
    // rides the epoch and no systemTokens price exists (the real cached row
    // that read 0 items while the breakdown still showed ≈1.6k). Routed through
    // headersOf — the boundary the real callers sanitize the projection with.
    const legacy = {
      headers: [{
        seq: 12,
        time: 1_000,
        system: 'You are an AI agent.\n',
        tools: [{ name: 'bash', tokens: 815, description: 'run', schema: { type: 'object' } }],
      }],
    } as unknown as ContextHeaders
    const data = tl({ current: { system: 9, tools: 815, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 824 } })
    const m = await mount(h(Browser, props({ data, headers: headersOf(legacy) })))
    assert.ok(text(catRow(m, 'system')).includes(kit.t('browser.items', { n: 1 })))
    await m.unmount()
  })

  test('a fetched epoch without a system prompt explains its absence', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 3, time: 3, systemTokens: 0, tools: [] }] }
    const data = tl({ current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 } })
    const m = await mount(h(Browser, props({
      data, headers, fetchHeader: () => Promise.resolve({ tools: [] }),
    })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('carried no system prompt'))
    await m.unmount()
  })

  test('a system prompt rides the timeline systems list, fetched from its own event seq', async () => {
    // The header epoch carries NO system price (the prompt is a
    // `system/message` surface node), so the section resolves the prompt
    // from `data.systems` and reads its text off that node's seq.
    const headers: ContextHeaders = { headers: [{ seq: 15, time: 1500, tools: [{ name: 'x', tokens: 1 }] }] }
    const data = tl({
      current: { system: 30, tools: 1, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 31 },
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const asked: number[] = []
    const fetchHeader = (seq: number): Promise<HeaderEpochContent> => {
      asked.push(seq)
      return Promise.resolve(seq === 7 ? { system: 'THE PROMPT', tools: [] } : { tools: [] })
    }
    const m = await mount(h(Browser, props({ data, headers, fetchHeader })))
    assert.ok(text(catRow(m, 'system')).includes(kit.t('browser.items', { n: 1 })))
    await click(catRow(m, 'system'))
    await flush()
    assert.deepEqual(asked, [7], 'the prompt is fetched from the system node, not the header epoch')
    assert.ok(text(query(m.container, '.lc-br-body')).includes('THE PROMPT'))
    await m.unmount()
  })

  test('a resolved prompt whose event carries no text explains its absence', async () => {
    // The node exists (so the category opens) but the fetched event maps to no prompt text — a foreign or truncated envelope.
    const data = tl({
      current: { system: 30, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 30 },
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const m = await mount(h(Browser, props({ data, fetchHeader: () => Promise.resolve({ tools: [] }) })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('carried no system prompt'))
    await m.unmount()
  })

  test('a step before the system node shows no prompt (the list is step-scoped)', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 3, time: 300, tools: [] }] }
    const data = tl({
      current: { system: 30, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 30 },
      requests: [req({ seq: 5, turn: 1, step: 0, system: 0, tools: 0, user: 5, total: 5 })],
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const m = await mount(h(Browser, props({ data, headers })))
    await pickStep(m, '5')
    assert.ok(text(catRow(m, 'system')).includes('0 Items'))
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'no prompt yet at this step')
    await m.unmount()
  })
})

