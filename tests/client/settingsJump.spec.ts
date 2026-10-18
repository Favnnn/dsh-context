// openPluginSettings (src/client/settingsJump.ts): the guarded DOM jump to the plugin's preferences on the Plugins
// main panel — panel entry first, the bundle card's open control after the page settles.

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { openPluginSettings } from '../../src/client/settingsJump'

/** Immediate scheduler: captures the deferred runs in issue order. */
function syncSchedule(): { runs: Array<() => void>; schedule: (run: () => void, ms: number) => void } {
  const runs: Array<() => void> = []
  return { runs, schedule: (run) => { runs.push(run) } }
}

/** A sidebar-style settings trigger (dialog semantics + expanded flag) — a distractor the jump must ignore. */
function trigger(doc: Document, expanded: 'true' | 'false'): HTMLButtonElement {
  const b = doc.createElement('button')
  b.setAttribute('aria-haspopup', 'dialog')
  b.setAttribute('aria-expanded', expanded)
  doc.body.appendChild(b)
  return b
}

function clicks(el: HTMLElement): { count: () => number } {
  let n = 0
  el.addEventListener('click', () => { n++ })
  return { count: () => n }
}

describe('openPluginSettings (the Plugins main panel)', () => {
  afterEach(() => {
    document.body.textContent = ''
  })

  /** A sidebar-style Plugins panel entry (shipped aria-label). */
  function panelEntry(doc: Document, label: string): HTMLButtonElement {
    const b = doc.createElement('button')
    b.setAttribute('aria-label', label)
    doc.body.appendChild(b)
    return b
  }

  /** The bundle card as the Plugins page ships it: a title button plus the enable switch. */
  function bundleCard(doc: Document, withTitle = true): { title: HTMLButtonElement; switchEl: HTMLButtonElement } {
    const li = doc.createElement('li')
    li.setAttribute('data-plugin-package', 'dsh-context')
    const title = doc.createElement('button')
    title.setAttribute('aria-label', 'View dsh-context')
    li.appendChild(title)
    const switchEl = doc.createElement('button')
    switchEl.setAttribute('role', 'switch')
    switchEl.setAttribute('aria-label', 'Enable dsh-context')
    li.appendChild(switchEl)
    if (!withTitle) title.remove()
    doc.body.appendChild(li)
    return { title, switchEl }
  }

  test('clicks the Plugins panel entry, then follows the page to the bundle card', () => {
    const panel = panelEntry(document, '插件')
    const pClicks = clicks(panel)
    const t = trigger(document, 'false')
    const tClicks = clicks(t)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(pClicks.count(), 1, 'the panel entry is clicked immediately')
    assert.equal(tClicks.count(), 0, 'the settings-dialog chrome is never touched')
    assert.equal(runs.length, 1, 'the card poll is scheduled')
    // The list has not rendered the card yet: the poll keeps ticking.
    runs[0]()
    assert.equal(runs.length, 2)
    const { title, switchEl } = bundleCard(document)
    const titleClicks = clicks(title)
    const switchClicks = clicks(switchEl)
    runs[1]()
    assert.equal(titleClicks.count(), 1, 'the title control opens the bundle page')
    assert.equal(switchClicks.count(), 0, 'the enable switch is never touched')
    assert.equal(runs.length, 2, 'the poll stops on success')
  })

  test('the en-labeled panel entry matches too', () => {
    const panel = panelEntry(document, 'Plugins')
    const pClicks = clicks(panel)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(pClicks.count(), 1)
    assert.equal(runs.length, 1)
  })

  test('the default schedule defers through window.setTimeout', async () => {
    const panel = panelEntry(document, '插件')
    const pClicks = clicks(panel)

    openPluginSettings(document)
    await new Promise(resolve => { setTimeout(resolve, 20) })

    assert.equal(pClicks.count(), 1)
  })

  test('the poll keeps ticking to its deadline and stops silently without a card', () => {
    const panel = panelEntry(document, 'Plugins')
    const pClicks = clicks(panel)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)
    // 1 bootstrap tick + 40 poll ticks, then the chain ends.
    for (let i = 0; i < 60 && runs.length > 0; i++) runs.shift()?.()

    assert.equal(pClicks.count(), 1)
    assert.equal(runs.length, 0, 'the poll exhausted its ticks and stopped')
  })

  test('a chrome without the Plugins panel entry degrades to a silent no-op', () => {
    trigger(document, 'false')
    const { runs, schedule } = syncSchedule()
    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    assert.equal(runs.length, 0, 'no card poll without the panel entry')
  })

  test('a panel entry that throws on click never surfaces the error', () => {
    const panel = panelEntry(document, '插件')
    panel.click = () => { throw new Error('detached') }
    const { runs, schedule } = syncSchedule()
    assert.doesNotThrow(() => openPluginSettings(document, schedule))
    // The entry's failure aborts this jump entirely — the guarded path.
    assert.equal(runs.length, 0)
  })

  test('a hostile card (no title control, or one that throws) never surfaces an error', () => {
    panelEntry(document, '插件')
    const { runs, schedule } = syncSchedule()
    openPluginSettings(document, schedule)
    runs.shift()?.()
    // Only a switch inside the card: no unique open control, the poll keeps ticking.
    bundleCard(document, false)
    assert.doesNotThrow(() => runs.shift()?.())
    assert.ok(runs.length > 0, 'still polling')
    // The card's title control throws on click: contained by the poll's guard, still polling.
    document.querySelector('[data-plugin-package="dsh-context"]')?.remove()
    const { title, switchEl } = bundleCard(document)
    const switchClicks = clicks(switchEl)
    title.click = () => { throw new Error('detached') }
    assert.doesNotThrow(() => runs.shift()?.())
    assert.equal(switchClicks.count(), 0, 'the enable switch is never touched')
  })

  test('lookalike aria-labels are ignored (exact match only)', () => {
    const lookalike = panelEntry(document, 'My Plugins')
    const lClicks = clicks(lookalike)
    const { runs, schedule } = syncSchedule()

    openPluginSettings(document, schedule)

    assert.equal(lClicks.count(), 0)
    assert.equal(runs.length, 0, 'no panel entry: silent no-op')
  })
})
