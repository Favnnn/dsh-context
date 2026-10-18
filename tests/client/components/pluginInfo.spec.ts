import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { makePluginInfo as makePluginInfoFn } from '../../../src/client/components/pluginInfo'
import { flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

/** Fresh pluginInfo module — resetModules so the baked-in version define starts clean;
 * `version` emulates the tsdown define. */
async function loadPluginInfo(version?: string): Promise<ReturnType<typeof makePluginInfoFn>> {
  vi.resetModules()
  if (version === undefined) delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
  else (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = version
  const mod = await import('../../../src/client/components/pluginInfo')
  return mod.makePluginInfo(kit)
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('PluginInfo', () => {
  test('dev build renders the static rows', async () => {
    const PluginInfo = await loadPluginInfo() // PLUGIN_VERSION = 0.0.0-dev
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.ok(text(m.container).includes('Plugin Info'))
    const rows = queryAll(m.container, '.lc-pi-row')
    assert.equal(rows.length, 3)
    // Every row's label leads with its site mark (DeepSeek / GitHub / the settings gear).
    for (const row of rows) assert.equal(queryAll(row, '.lc-pi-label .lc-pi-labelicon').length, 1)
    assert.equal(query(rows[0], '.lc-pi-label').textContent, 'Plugin')
    assert.equal(query(rows[0], '.lc-pi-value').textContent, 'dsh-context (v0.0.0-dev)')
    assert.equal(rows[0].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(rows[0].getAttribute('target'), '_blank')
    assert.equal(query(rows[1], '.lc-pi-label').textContent, 'GitHub')
    assert.equal(query(rows[1], '.lc-pi-value').textContent, 'bowenliang123/dsh-context')
    assert.equal(rows[1].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    // The settings entry: a button (no href) below GitHub — the guarded jump runs on click.
    assert.equal(rows[2].getAttribute('href'), null)
    assert.equal(query(rows[2], '.lc-pi-label').textContent, 'Plugin Settings')
    assert.equal(query(rows[2], '.lc-pi-value').textContent, 'Open plugin settings')
    const hint = query(m.container, '.lc-pi-hint')
    assert.ok(text(hint).includes('The best DSH context plugin'))
    assert.equal(hint.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(hint.getAttribute('target'), '_blank')
    assert.equal(hint.getAttribute('rel'), 'noreferrer')
    // The settings entry runs the guarded jump; without the harness chrome in
    // the jsdom document it silently no-ops — safe to click in tests.
    assert.doesNotThrow(() => rows[2].click())
    await m.unmount()
  })
})
