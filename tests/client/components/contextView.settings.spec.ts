import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { createContextSettings } from '../../../src/client/settings'
import type { SettingsScopeLike } from '../../../src/client/settings'
import type { UseChatLike } from '../../../src/client/services'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestLocale } from '../helpers/harness'
import { click, flush, mount, query, queryAll, silenceWindowErrors, text } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — locale and settings', () => {
  // A real-shaped models.dev slice: the cost cell prices against the injected
  // book (1M uncached input at the $0.15 miss rate → $0.15 / ¥1).
  const costed = timeline({
    cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } } } },
  })

  beforeEach(() => {
    resetModelPrices()
    setModelPricesLoader(() => Promise.resolve({
      deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    }))
  })

  afterEach(() => {
    resetModelPrices()
  })

  test('cost prices in USD by default (no locale service), CNY under zh', async () => {
    const m1 = await mount(h(makeView(new TestClientCtx()), {
      sessionId: 'sv-usd',
      useProjection: projectionsFor(costed),
    }))
    await flush()
    assert.ok(text(m1.container).includes('$'))
    assert.ok(!text(m1.container).includes('¥'))
    await m1.unmount()

    const ctxZh = new TestClientCtx({ services: { locale: Object.assign(new TestLocale(), { active: 'zh' }) } })
    const m2 = await mount(h(makeView(ctxZh), {
      sessionId: 'sv-cny',
      useProjection: projectionsFor(costed),
    }))
    await flush()
    assert.ok(text(m2.container).includes('¥'))
    await m2.unmount()

    const ctxBare = new TestClientCtx({ services: { locale: {} } })
    const m3 = await mount(h(makeView(ctxBare), {
      sessionId: 'sv-bare',
      useProjection: projectionsFor(costed),
    }))
    await flush()
    assert.ok(text(m3.container).includes('$'))
    await m3.unmount()
  })

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = createContextSettings()
    const scope: SettingsScopeLike = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path', defaultDurationCurve: 'hide' },
      }),
      subscribe: () => () => {},
      set: async () => {},
    }
    const detach = settings.attach(scope)
    const View = makeView(new TestClientCtx(), settings)
    // Two file reads (the 2-op path sorts AFTER the 1-op one under 'count' but BEFORE it under 'path').
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline({
        nodes: [
          ...richTimeline().nodes,
          { seq: 7, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 6000 },
          { seq: 8, cat: 'tool', tokens: 30, tool: 'read', text: 'a', time: T0 + 7000 },
          { seq: 9, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 8000 },
        ],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] } })) as UseChatLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    // The 'hide' curve preference mounts the Duration toggle off (the schema default mounts it on).
    assert.ok(!buttonByText(m.container, DICT_EN['trend.duration']).className.includes('lc-gran-on'))
    // Turn aggregation applies at mount: two bars (turn 1 aggregate + turn-less).
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/a.ts', '/z.ts'])
    await m.unmount()
    detach()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    // React 18 dev replays the failed render through a fake DOM event (loud
    // stderr via jsdom/vitest) and logs the boundary message to console —
    // both silenced so the deliberate throw stays inside this test.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
      const real = createContextSettings()
      // Flag-driven (not call-counted): React 18 dev replays a failed unit of
      // work and retries an errored concurrent pass synchronously, so the
      // failure must persist until the boundary catches, then clear for Retry.
      let fail = true
      const flaky = {
        ...real,
        defaultGranularity: (): 'step' | 'turn' => {
          if (fail) throw new Error('boom-settings')
          return real.defaultGranularity()
        },
      }
      const View = makeView(new TestClientCtx(), flaky)
      const m = await mount(h(View, {
        sessionId: 'sv-err',
        useProjection: projectionsFor(richTimeline()),
      }))
      assert.ok(text(m.container).includes(DICT_EN.error))
      assert.ok(text(m.container).includes('boom-settings'))

      fail = false
      await click(query(m.container, '.lc-error-retry'))
      assert.ok(text(m.container).includes(DICT_EN['overview.title']))
      assert.ok(!text(m.container).includes(DICT_EN.error))
      await m.unmount()
    } finally {
      silenceErrors()
    }
  })
})
