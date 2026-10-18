// ContextView — the overview face: chip placement and exclusivity, the ribbon swap, and the turn-strip click that
// pins the turn in turn granularity.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import { click, query, queryAll, text } from '../helpers/kit'
import { buttonByText, mountRich } from './contextViewHarness'

describe('ContextView — overview face', () => {
  test('the Overview chip rides right of Duration and clears DNA/Adaptive on activation', async () => {
    const m = await mountRich('sv-overview-chip')
    const mods = buttonByText(m.container, DICT_EN['trend.dna']).parentElement as HTMLElement
    const last = (mods.lastElementChild as HTMLElement).textContent
    assert.equal(last, DICT_EN['trend.overview'], 'Overview is the mods group\'s last chip')

    const overview = () => buttonByText(m.container, DICT_EN['trend.overview'])
    const dna = () => buttonByText(m.container, DICT_EN['trend.dna'])
    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    await click(dna())
    assert.ok(dna().className.includes('lc-gran-on'))
    // Overview activation clears DNA; DNA activation clears Overview.
    await click(overview())
    assert.ok(overview().className.includes('lc-gran-on'))
    assert.equal(dna().className.includes('lc-gran-on'), false)
    await click(dna())
    assert.equal(overview().className.includes('lc-gran-on'), false)
    assert.ok(dna().className.includes('lc-gran-on'))
    // Adaptive coexists with DNA but activation still clears Overview.
    await click(adaptive())
    assert.ok(dna().className.includes('lc-gran-on'))
    assert.ok(adaptive().className.includes('lc-gran-on'))
    await click(overview())
    assert.equal(dna().className.includes('lc-gran-on'), false)
    assert.equal(adaptive().className.includes('lc-gran-on'), false)
    assert.ok(overview().className.includes('lc-gran-on'))
    // Toggling off restores the bars face.
    await click(overview())
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    await m.unmount()
  })

  test('the overview face swaps the bars for a full-width ribbon with the same detail flow', async () => {
    const m = await mountRich('sv-overview-ribbon')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.match(query(m.container, '.lc-chart-scroll').className, /lc-chart-fit/)
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 2 112')
    // The whole retained log's axis: max 420.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '420')
    // Quartile + full-span step flags (3 records: the interior ½ and the full span) and the turn strip's labels.
    assert.deepEqual(queryAll(m.container, '.lc-step-flag-label').map(f => f.textContent), ['2', '3'])
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['1', '0'])

    // Clicking a strip block forces turn granularity and pins the turn's closing record.
    await click(query(m.container, '.lc-turn'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.match(query(m.container, '.lc-fit-cursor').className, /lc-fit-pin/)
    assert.ok(text(m.container).includes(DICT_EN['detail.turn'].replace('{t}', '1').replace('{n}', '2')))
    await m.unmount()
  })
})
