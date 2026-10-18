import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeCurrentComposition } from '../../../src/client/components/currentComposition'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import type { Headline } from '../../../src/client/headline'
import { hover, makeKit, mount, query, queryAll, text, tipRows } from '../helpers/kit'

const kit = makeKit()
const CurrentComposition = makeCurrentComposition(kit, makeStackedBar(kit), makeLegend(kit))

const PARTS = [{ key: 'user', color: '#123456', value: 5000 }]

function headOf(over: Partial<Headline> = {}): Headline {
  return { tokens: 5000, pct: null, parts: PARTS, ...over }
}

describe('CurrentComposition header', () => {
  test('windowed head: tokens/window figure, used percentage, reserve masks, subtitle', async () => {
    const m = await mount(h(CurrentComposition, {
      head: headOf({ window: 10000, pct: 50.4, reserve: { threshold: 8000, headroom: 1000, output: 1000 } }),
      subtitle: 'deepseek-v4-flash',
    }))
    assert.ok(text(m.container).includes('Current Context'))
    assert.equal(query(m.container, '.lc-card-sub').textContent, 'deepseek-v4-flash')
    const num = query(m.container, '.lc-overview-num')
    assert.ok(text(num).includes('5.0k / 10.0k tokens'))
    // The reading keeps one decimal, a whole tenth included (headline.ts).
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.4%')
    // The two masks split the reserve: the compaction headroom, then the output reservation.
    const headroom = query(m.container, '.lc-reserve-headroom')
    const output = query(m.container, '.lc-reserve-output')
    assert.equal(headroom.style.left, '80%')
    assert.equal(output.style.left, '90%')
    await hover(headroom)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['Compaction Headroom', '1.0k', 'Auto-compaction is expected to fire at 80% of the window'])
    await hover(output)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['LLM Output Reservation', '1.0k', 'The model\'s maximum output tokens'])
    await m.update(h(CurrentComposition, { head: headOf({ window: 10000, pct: 50 }) }))
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.0%')
    assert.ok(text(num).includes('of context used'))
    await m.unmount()
  })

  test('windowless head: estimate label, no percentage, no reserve, no subtitle', async () => {
    const m = await mount(h(CurrentComposition, { head: headOf() }))
    assert.ok(text(m.container).includes('tokens (estimated)'))
    assert.equal(queryAll(m.container, '.lc-overview-pct').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    await m.update(h(CurrentComposition, { head: headOf({ window: 0 }), subtitle: '' }))
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.ok(text(m.container).includes('tokens (estimated)'))
    await m.unmount()
  })
})