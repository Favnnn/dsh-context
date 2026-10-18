// The Context Insights page's registrations (src/client/insightPage.ts): the keyed `main` panel and the
// `sidebar.panellist` entry under one id, mounted while the `insightsEntry` preference shows them and unwound on 'hide'.

import assert from 'node:assert/strict'
import { createElement as h, type ReactElement } from 'react'
import { describe, test } from 'vitest'
import { INSIGHT_PANEL_ID, INSIGHT_PANEL_ORDER, watchInsightPage } from '../../src/client/insightPage'
import { createContextSettings } from '../../src/client/settings'
import { InsightPanelIcon } from '../../src/client/icon'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { makeKit, mount } from './helpers/kit'

const NS = 'dsh-context'

function page(_props: { sessionId?: string } & Record<string, unknown>): null {
  return null
}

describe('watchInsightPage', () => {
  test("the default 'show' mounts both registrations under one identity", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)

    const main = ctx.slots.of('main')
    assert.equal(main.length, 1, 'the page rides the keyed main seat')
    assert.equal(main[0].registration.name, 'main')
    assert.equal(main[0].registration.key, INSIGHT_PANEL_ID)
    assert.equal(main[0].registration.locale, NS)
    assert.equal(main[0].component, page, 'the page component registered verbatim')

    const entries = ctx.slots.of('sidebar.panellist')
    assert.equal(entries.length, 1, 'the entry rides the sidebar panel list')
    assert.equal(entries[0].registration.name, 'sidebar.panellist')
    assert.equal(entries[0].registration.id, INSIGHT_PANEL_ID, 'the entry id addresses the main panel')
    assert.equal(entries[0].registration.order, INSIGHT_PANEL_ORDER)
    assert.equal(entries[0].registration.locale, NS)
    assert.equal(entries[0].registration.label?.(), 'Context Insights', 'the label thunk resolves the page title')
    const iconEl = entries[0].component({ size: 16 }) as ReactElement
    assert.equal((iconEl.type as { name: string }).name, 'InsightPanelIcon', 'the entry glyph component')
    dispose()
  })

  test("'hide' unwinds both registrations; 'show' mounts them again", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)
    assert.equal(ctx.slots.of('main').length, 1)

    settings.set('insightsEntry', 'hide')
    assert.equal(ctx.slots.of('main').length, 0, 'hiding the entry unwinds the page')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0, 'hiding unwinds the entry')

    settings.set('insightsEntry', 'show')
    assert.equal(ctx.slots.of('main').length, 1, 'showing remounts the pair')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)

    // Unrelated preference changes never churn the mounts.
    settings.set('defaultGranularity', 'turn')
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    dispose()
  })

  test("a 'hide' start mounts nothing; the watcher disposer unwinds a live mount exactly once", () => {
    const hidden = new TestClientCtx()
    const hiddenSettings = createContextSettings()
    hiddenSettings.set('insightsEntry', 'hide')
    const { t } = makeKit()
    const disposeHidden = watchInsightPage(asClientCtx(hidden), hiddenSettings, page, t, NS)
    assert.equal(hidden.slots.of('main').length, 0)
    assert.equal(hidden.slots.of('sidebar.panellist').length, 0)
    disposeHidden()
    // A later flip reaches no mount: the subscription is gone.
    hiddenSettings.set('insightsEntry', 'show')
    assert.equal(hidden.slots.of('main').length, 0)

    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)
    dispose()
    assert.equal(ctx.slots.of('main').length, 0, 'the disposer unwinds the live mount')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0)
    assert.doesNotThrow(dispose, 'the disposer is safe to repeat')
  })

  test('the panel-list icon renders the mono emblem at the asked size', async () => {
    const m = await mount(h(InsightPanelIcon, { size: 16 }))
    const svg = m.container.querySelector('svg')
    assert.ok(svg !== null)
    assert.equal(svg.getAttribute('width'), '16')
    assert.ok(svg.innerHTML.includes('currentColor'), 'the mono seat trades fills for the text colour')
    await m.unmount()
  })

  test('the entry glyph wrapper passes a numeric owner size through and defaults otherwise', async () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)
    const icon = ctx.slots.of('sidebar.panellist')[0].component
    const sized = await mount(icon({ size: 18 }) as ReactElement)
    assert.equal(sized.container.querySelector('svg')?.getAttribute('width'), '18')
    await sized.unmount()
    const bare = await mount(icon({}) as ReactElement)
    assert.equal(bare.container.querySelector('svg')?.getAttribute('width'), '18', 'a non-number owner share falls to the icon default')
    await bare.unmount()
    dispose()
  })

  test('a slots face returning no disposer is tolerated across flips and dispose', () => {
    // A minimal face: inject/register land nothing unwindable (the harness contract allows either to return no handle).
    const bare = {
      slots: {
        inject: (_name: string, cb: () => unknown) => { cb(); return undefined },
        register: () => undefined,
      },
    }
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(bare as never, settings, page, t, NS)
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'hide') })
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'show') })
    assert.doesNotThrow(dispose)
  })
})
