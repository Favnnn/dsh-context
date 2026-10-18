import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeOverviewSkills, skillColorOf } from '../../../src/client/components/overviewSkills'
import type { SkillLoadStat } from '../../../src/client/overview'
import { setSkillCopier } from '../../../src/client/skills'
import type { SkillInfo } from '../../../src/shared/types'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const Skills = makeOverviewSkills(makeKit('en'))
const SkillsZh = makeOverviewSkills(makeKit('zh'))

const NOW = Date.UTC(2026, 8, 20, 12)

function stat(name: string, loads: number, last: number, sessions = 1): SkillLoadStat {
  return { name, loads, sessions, last }
}

/** A catalog fixture: the full entry, a path-less project entry, and an unknown-source entry with a long description. */
const CATALOG: ReadonlyMap<string, SkillInfo> = new Map([
  ['tdd', { name: 'tdd', description: 'Test-driven development.\nWrite the test first.', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents' }],
  ['grill-me', { name: 'grill-me', description: '', source: 'project-dsh' }],
  ['custom-skill', { name: 'custom-skill', description: ` ${'x'.repeat(200)} `, path: '/opt/skills/custom.md', source: 'team-registry' }],
])

/** The portaled hover card (document.body), when shown. */
function bubble(): HTMLElement | null {
  return document.querySelector('#lc-skilltip-bubble')
}

/** Pin a row's anchor geometry for the measure assertions (jsdom rects are all zero). */
function mockRect(row: Element, rect: { left: number; top: number; width: number; bottom: number }): void {
  Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ ...rect, right: rect.left + rect.width, height: 20 }) })
}

afterEach(() => {
  setSkillCopier(null)
})

describe('skillColorOf', () => {
  test('the palette pick is stable and palette-bound', () => {
    assert.equal(skillColorOf('tdd'), skillColorOf('tdd'))
    for (const name of ['tdd', 'grill-me', 'ponytail', 'ask-matt', 'a']) {
      assert.ok(skillColorOf(name).startsWith('var(--color-'), name)
    }
  })
})

describe('OverviewSkills', () => {
  test('the empty scope renders the note, no summary, no detail block', async () => {
    const m = await mount(h(Skills, { stats: [], now: NOW }))
    assert.ok(text(m.container).includes('No skill loads in this range'))
    assert.equal(queryAll(m.container, '.lc-ov-skills-sub').length, 0)
    assert.equal(queryAll(m.container, '.lc-ov-skill').length, 0)
    assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0, 'no detail without a pin')
    await m.unmount()
  })

  test('each row shows the dot, the name, the tally, the last load’s relative time, and its share bar', async () => {
    const m = await mount(h(Skills, {
      stats: [stat('tdd', 12, NOW - 3 * 3_600_000), stat('grill-me', 3, NOW - 40_000)],
      now: NOW,
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-skill')
    assert.equal(rows.length, 2)
    assert.equal(text(query(rows[0], '.lc-ov-skill-name')), 'tdd')
    assert.equal(text(query(rows[0], '.lc-ov-skill-count')), '×12')
    assert.equal(text(query(rows[0], '.lc-ov-skill-last')), '3h ago')
    assert.equal(text(query(rows[1], '.lc-ov-skill-last')), 'just now')
    // jsdom's CSSOM drops var() from the shorthand property read — the attribute string is the truth.
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-skill-dot').getAttribute('style')?.includes(skillColorOf('tdd')))
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    assert.ok(query<HTMLElement>(rows[1], '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(25% - 3px)'), 'the share of the heaviest row')
    // The summary sub under the title names both figures — the distinct skills and the total loads.
    assert.ok(text(query(m.container, '.lc-ov-skills-sub')).includes('2 skills · 15 loads'))
    await m.unmount()
  })

  test('the share bar scales to the heaviest row wherever the ordering puts it — never past the content edge', async () => {
    // A recent ordering can lead with a lighter row; the bar's denominator
    // must still be the heaviest tally (a first-row denominator overflowed
    // the card at 200%), and the width subtracts the row's horizontal insets
    // so 100% stops at the content edge instead of crossing the unit's ring.
    const m = await mount(h(Skills, { stats: [stat('light', 1, NOW), stat('heavy', 2, NOW)], now: NOW }))
    const rows = queryAll<HTMLElement>(m.container, 'button.lc-ov-skill')
    assert.ok(query(rows[0], '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(50% - 6px)'))
    assert.ok(query(rows[1], '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    await m.unmount()
    // A hostile all-zero scope divides safely into empty bars.
    const zero = await mount(h(Skills, { stats: [stat('zero', 0, NOW)], now: NOW }))
    assert.ok(query<HTMLElement>(zero.container, '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(0% - 0px)'))
    await zero.unmount()
  })

  test('a row click pins and releases through onSelect; the pinned row wraps with its detail into one unit', async () => {
    const picks: (string | null)[] = []
    const m = await mount(h(Skills, {
      stats: [stat('tdd', 2, NOW), stat('grill-me', 1, NOW)],
      selected: 'tdd',
      onSelect: (name) => { picks.push(name) },
      now: NOW,
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-skill')
    assert.ok((rows[0].parentElement as HTMLElement).className.includes('lc-ov-skill-unit'), 'the pinned row’s wrapper carries the ring')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true')
    assert.equal(rows[1].getAttribute('aria-pressed'), 'false')
    await click(rows[1])
    assert.deepEqual(picks, ['grill-me'])
    await click(rows[0])
    assert.deepEqual(picks, ['grill-me', null], 'clicking the pinned row releases the pin')
    await m.unmount()
  })

  test('a row click without a relay only renders', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 2, NOW)], now: NOW }))
    await click(query(m.container, 'button.lc-ov-skill'))
    await m.unmount()
  })

  test('the hover card lays out the head, the description, the path, and the stats/action footer', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 2, NOW - 3_600_000)], catalog: CATALOG, now: NOW }))
    assert.equal(bubble(), null, 'no card before a hover')
    const row = query(m.container, 'button.lc-ov-skill')
    await hover(row)
    const tip = bubble()
    assert.ok(tip, 'the card portals to <body>')
    assert.equal(row.getAttribute('aria-describedby'), 'lc-skilltip-bubble')
    assert.equal(text(query(tip!, '.lc-skilld-name')), 'tdd')
    assert.equal(text(query(tip!, '.lc-skilld-chip')), 'User')
    assert.equal(text(query(tip!, '.lc-skilld-desc')), 'Test-driven development. Write the test first.', 'the description flattens to one flow')
    assert.equal(text(query(tip!, '.lc-skilld-path')), '/home/u/.agents/skills/tdd/SKILL.md')
    assert.ok(/2 loads · 1 sessions · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text(query(tip!, '.lc-skilld-foot'))))
    assert.equal(text(query(tip!, '.lc-skilld-hint')), 'Click to filter the sessions that loaded it')
    await unhover(row)
    assert.equal(bubble(), null, 'leaving the row retracts the card')
    assert.equal(row.getAttribute('aria-describedby'), null)
    await m.unmount()
  })

  test('the bare hover card carries the stats and the hint without catalog lines', async () => {
    const m = await mount(h(Skills, { stats: [stat('ghost', 3, NOW)], now: NOW }))
    await hover(query(m.container, 'button.lc-ov-skill'))
    const tip = bubble()
    assert.ok(tip)
    assert.equal(text(query(tip!, '.lc-skilld-name')), 'ghost')
    assert.equal(queryAll(tip!, '.lc-skilld-chip').length, 0, 'no origin without a catalog entry')
    assert.equal(queryAll(tip!, '.lc-skilld-desc').length, 0)
    assert.equal(queryAll(tip!, '.lc-skilld-path').length, 0)
    assert.ok(text(query(tip!, '.lc-skilld-foot')).includes('3 loads'))
    await m.unmount()
  })

  test('the origin buckets localize; the long description caps; the pinned row’s hint flips to release', async () => {
    const m = await mount(h(Skills, {
      stats: ['a-project', 'b-user', 'c-bundled', 'd-bare'].map(name => stat(name, 1, NOW)),
      catalog: new Map<string, SkillInfo>([
        ['a-project', { name: 'a-project', description: '', source: 'project-agents' }],
        ['b-user', { name: 'b-user', description: '', source: 'user-dsh' }],
        ['c-bundled', { name: 'c-bundled', description: '', source: 'bundled' }],
        ['d-bare', { name: 'd-bare', description: '' }],
      ]),
      selected: 'a-project',
      now: NOW,
    }))
    const rows = queryAll(m.container, 'button.lc-ov-skill')
    const chipOf = async (row: Element): Promise<string> => {
      await hover(row)
      const chip = bubble()?.querySelector('.lc-skilld-chip')
      return chip === null || chip === undefined ? '' : (chip.textContent ?? '')
    }
    assert.equal(await chipOf(rows[0]), 'Project')
    assert.equal(text(query(bubble()!, '.lc-skilld-hint')), 'Click again to release the filter', 'the pinned row’s hint')
    assert.equal(await chipOf(rows[1]), 'User')
    assert.equal(await chipOf(rows[2]), 'Built-in')
    assert.equal(await chipOf(rows[3]), '', 'a source-less entry carries no chip')
    await unhover(rows[3])
    const m2 = await mount(h(Skills, { stats: [stat('custom-skill', 1, NOW)], catalog: CATALOG, now: NOW }))
    await hover(query(m2.container, 'button.lc-ov-skill'))
    assert.equal(text(query(bubble()!, '.lc-skilld-chip')), 'team-registry')
    const desc = text(query(bubble()!, '.lc-skilld-desc'))
    assert.equal(desc.length, 161, 'the 160 cap plus the ellipsis')
    assert.ok(desc.endsWith('…'))
    await m2.unmount()
    await m.unmount()
  })

  test('the card measures against the row: centered and clamped inside the viewport, flipping below at the top edge', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], now: NOW }))
    const row = query(m.container, 'button.lc-ov-skill')
    // jsdom's zero rect flips below and clamps to the left margin.
    await hover(row)
    let style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 8px'), style)
    assert.ok(style.includes('top: 6px'), style)
    await unhover(row)
    // Mid-viewport: centered on the row, above it (jsdom bubbles measure 0×0).
    mockRect(row, { left: 500, top: 200, width: 100, bottom: 220 })
    await hover(row)
    style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 550px'), style)
    assert.ok(style.includes('top: 194px'), style)
    await unhover(row)
    // Off the right edge: clamped to the viewport margin (jsdom innerWidth 1024).
    mockRect(row, { left: 2000, top: 200, width: 100, bottom: 220 })
    await hover(row)
    style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 1016px'), style)
    await m.unmount()
  })

  test('a scroll or a resize retracts the card; focus and blur drive it too', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], now: NOW }))
    const row = query(m.container, 'button.lc-ov-skill')
    await hover(row)
    assert.ok(bubble())
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    assert.equal(bubble(), null, 'any scroll retracts')
    await hover(row)
    assert.ok(bubble())
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    assert.equal(bubble(), null, 'a resize retracts')
    // React implements onFocus/onBlur over the bubbling focusin/focusout pair.
    await act(async () => { row.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.ok(bubble(), 'keyboard focus raises the card')
    await act(async () => { row.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.equal(bubble(), null, 'blur retracts')
    await m.unmount()
  })

  test('a scope change under the hover drops the card’s content', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], now: NOW }))
    await hover(query(m.container, 'button.lc-ov-skill'))
    assert.ok(bubble())
    await m.update(h(Skills, { stats: [stat('other', 1, NOW)], now: NOW }))
    assert.equal(bubble(), null, 'the hovered skill left the scope — nothing to say')
    await m.unmount()
  })

  test('the pinned skill’s detail expands inline under its row: description first, then the fact grid with the copyable path', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      setSkillCopier(async (path) => { writes.push(path) })
      const m = await mount(h(Skills, {
        stats: [stat('tdd', 2, NOW, 2), stat('grill-me', 1, NOW)],
        selected: 'tdd',
        catalog: CATALOG,
        now: NOW,
      }))
      const row = query<HTMLButtonElement>(m.container, 'button.lc-ov-skill')
      const detail = row.nextElementSibling as HTMLElement
      assert.ok(detail.classList.contains('lc-ov-skill-detail'), 'the detail hugs the pinned row, not the card bottom')
      assert.equal(queryAll(detail, '.lc-skilld-head').length, 0, 'the inline seat needs no head — the row above names the skill')
      assert.equal(text(query(detail, '.lc-skilld-desc')), 'Test-driven development. Write the test first.')
      assert.ok(detail.querySelector('.lc-skilld-desc + .lc-skilld-grid') !== null, 'the description leads, the grid follows')
      const grid = query(detail, '.lc-skilld-grid')
      assert.deepEqual(queryAll(grid, '.lc-skilld-k').map(k => text(k)), ['Source', 'Usage', 'Last', 'Path'])
      const values = queryAll(grid, '.lc-skilld-v')
      assert.equal(text(values[0]), 'User')
      assert.equal(text(values[1]), '2 loads · 2 sessions', 'the in-scope pin’s stats')
      assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text(values[2])), 'the exact last load')
      const pathBtn = query<HTMLButtonElement>(grid, 'button.lc-skilld-pathv')
      assert.equal(text(query(pathBtn, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md')
      assert.equal(pathBtn.getAttribute('data-lc-tip'), 'Click to copy the path')
      await click(pathBtn)
      await flush()
      assert.deepEqual(writes, ['/home/u/.agents/skills/tdd/SKILL.md'])
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied', 'the flash claims the landed copy')
      // A second click mid-flash re-arms the timer — the flash holds.
      await click(query(m.container, 'button.lc-skilld-pathv'))
      await flush()
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied')
      await act(async () => { vi.advanceTimersByTime(1600) })
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md', 'the dwell passes, the path returns')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed copy never flashes', async () => {
    setSkillCopier(async () => { throw new Error('denied') })
    const m = await mount(h(Skills, {
      stats: [stat('tdd', 2, NOW)],
      selected: 'tdd',
      catalog: CATALOG,
      now: NOW,
    }))
    await click(query(m.container, 'button.lc-skilld-pathv'))
    await flush()
    assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md')
    await m.unmount()
  })

  test('an out-of-scope pin falls back to a detached block at the bottom, head included; moving the pin resets the flash', async () => {
    vi.useFakeTimers()
    try {
      setSkillCopier(async () => {})
      const m = await mount(h(Skills, { stats: [], selected: 'tdd', catalog: CATALOG, now: NOW }))
      assert.ok(text(m.container).includes('No skill loads in this range'), 'the scope stays empty')
      const detail = query(m.container, '.lc-ov-skill-detail')
      assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 0, 'no row to hug')
      assert.equal(text(query(detail, '.lc-skilld-head .lc-skilld-name')), 'tdd', 'the detached seat carries the head')
      assert.deepEqual(queryAll(detail, '.lc-skilld-k').map(k => text(k)), ['Source', 'Path'], 'no usage rows for an out-of-scope pin')
      await click(query(m.container, 'button.lc-skilld-pathv'))
      await flush()
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied')
      await m.update(h(Skills, { stats: [], selected: 'custom-skill', catalog: CATALOG, now: NOW }))
      assert.equal(text(query(m.container, '.lc-skilld-grid .lc-skilld-v')), 'team-registry', 'the unknown source displays raw in the grid')
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), '/opt/skills/custom.md')
      // The pin releases: the block leaves (with its timer pending — the unmount-style cleanup runs here).
      await m.update(h(Skills, { stats: [], selected: null, catalog: CATALOG, now: NOW }))
      assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a catalog-less pin with in-scope tallies still shows its usage rows; a ghost pin renders nothing', async () => {
    const noCatalog = await mount(h(Skills, { stats: [stat('tdd', 4, NOW)], selected: 'tdd', catalog: null, now: NOW }))
    const detail = query(noCatalog.container, '.lc-ov-skill-detail')
    assert.equal(queryAll(detail, '.lc-skilld-head').length, 0)
    assert.deepEqual(queryAll(detail, '.lc-skilld-k').map(k => text(k)), ['Usage', 'Last'], 'no source or path without the catalog')
    assert.ok(text(queryAll(detail, '.lc-skilld-v')[0]).includes('4 loads'))
    assert.equal(queryAll(detail, '.lc-skilld-pathv').length, 0)
    await noCatalog.unmount()
    const ghost = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], selected: 'ghost', catalog: CATALOG, now: NOW }))
    assert.equal(queryAll(ghost.container, '.lc-ov-skill-detail').length, 0)
    await ghost.unmount()
  })

  test('a hostile instant degrades the stats line, never the row', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, Number.NaN)], now: NOW }))
    assert.equal(text(query(m.container, '.lc-ov-skill-last')), 'just now')
    await hover(query(m.container, 'button.lc-ov-skill'))
    const foot = text(query(bubble()!, '.lc-skilld-foot'))
    assert.ok(foot.includes('1 loads'), foot)
    assert.ok(!foot.includes('null') && !foot.includes('NaN'), foot)
    await m.unmount()
  })

  test('the heatmap’s pinned day is named in the title', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], day: '2026-09-19', now: NOW }))
    assert.ok(text(query(m.container, '.lc-card-title')).includes('2026-09-19'))
    await m.unmount()
  })

  test('the render bound lists twenty rows and counts the overflow', async () => {
    const stats = Array.from({ length: 25 }, (_, i) => stat(`skill-${i}`, i + 1, NOW - i * 1000))
    const m = await mount(h(Skills, { stats, now: NOW }))
    assert.equal(queryAll(m.container, '.lc-ov-skill').length, 20)
    assert.ok(text(m.container).includes('5 more skills'))
    await m.unmount()
  })

  test('the sort toggle lists the two orderings, marks the active one, and relays picks', async () => {
    const picks: string[] = []
    const m = await mount(h(Skills, {
      stats: [stat('tdd', 2, NOW), stat('grill-me', 1, NOW)],
      sort: 'recent',
      onSort: (next) => { picks.push(next) },
      now: NOW,
    }))
    const group = query(m.container, '.lc-card-title .lc-gran')
    const buttons = queryAll<HTMLButtonElement>(group, 'button')
    assert.deepEqual(buttons.map(b => text(b)), ['Loads', 'Recent'])
    assert.equal(buttons[1].getAttribute('aria-pressed'), 'true', 'the picked ordering')
    assert.ok(buttons[1].className.includes('lc-gran-on'))
    await click(buttons[0])
    assert.deepEqual(picks, ['loads'])
    await m.unmount()
    // Fewer than two rows: nothing to order, the toggle stays out.
    const one = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], onSort: () => {}, now: NOW }))
    assert.equal(queryAll(one.container, '.lc-card-title .lc-gran').length, 0)
    await one.unmount()
    // No sort prop and no relay: the loads ordering is marked, a click only renders.
    const bare = await mount(h(Skills, { stats: [stat('a', 1, NOW), stat('b', 2, NOW)], now: NOW }))
    const bareButtons = queryAll<HTMLButtonElement>(bare.container, '.lc-card-title .lc-gran button')
    assert.equal(bareButtons[0].getAttribute('aria-pressed'), 'true')
    await click(bareButtons[1])
    await bare.unmount()
  })

  test('the name filter narrows the rows and the summary, case-insensitively; clearing restores', async () => {
    const m = await mount(h(Skills, {
      stats: [stat('ponytail', 2, NOW), stat('grilling', 1, NOW), stat('grill-me', 1, NOW)],
      now: NOW,
    }))
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-skills-search')
    assert.equal(input.getAttribute('aria-label'), 'Search skills…')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 3)
    assert.ok(text(query(m.container, '.lc-ov-skills-sub-n')).includes('3 skills · 4 loads'))
    await actType(input, 'GRILL')
    assert.deepEqual(
      queryAll(m.container, '.lc-ov-skill-name').map(n => text(n)),
      ['grilling', 'grill-me'],
      'the substring match ignores case',
    )
    assert.ok(text(query(m.container, '.lc-ov-skills-sub-n')).includes('2 skills · 2 loads'), 'the counts follow the filter')
    await actType(input, '  grill-me  ')
    assert.deepEqual(queryAll(m.container, '.lc-ov-skill-name').map(n => text(n)), ['grill-me'], 'the query trims')
    await actType(input, '')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 3, 'clearing restores the scope')
    await m.unmount()
  })

  test('an empty match keeps the filter input mounted and swaps the note; a lone row offers nothing to filter', async () => {
    const m = await mount(h(Skills, { stats: [stat('tdd', 1, NOW), stat('grill-me', 1, NOW)], now: NOW }))
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-skills-search')
    await actType(input, 'zzz')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 0)
    assert.ok(text(query(m.container, '.lc-ov-skills-sub-n')).includes('0 skills · 0 loads'), 'the counts follow the filter down to zero')
    assert.ok(text(m.container).includes('No skills match the current filter'))
    await actType(input, 'tdd')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 1, 'the input stays mounted and can clear the filter')
    await m.unmount()
    const one = await mount(h(Skills, { stats: [stat('tdd', 1, NOW)], now: NOW }))
    assert.equal(queryAll(one.container, 'input.lc-ov-skills-search').length, 0, 'a lone row has nothing to filter')
    await one.unmount()
    const empty = await mount(h(Skills, { stats: [], now: NOW }))
    assert.equal(queryAll(empty.container, 'input.lc-ov-skills-search').length, 0)
    await empty.unmount()
  })

  test('a pin the filter hides falls back to the detached block; the filtered overflow line counts the matches', async () => {
    const stats = Array.from({ length: 25 }, (_, i) => stat(`skill-${i}`, i + 1, NOW - i * 1000))
    stats.push(stat('grill-me', 1, NOW))
    const m = await mount(h(Skills, { stats, selected: 'skill-24', now: NOW }))
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-skills-search')
    await actType(input, 'grill')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 1)
    const detail = query(m.container, '.lc-ov-skill-detail')
    assert.equal(detail.closest('.lc-ov-skill-unit'), null, 'no inline seat without the pinned row')
    assert.equal(queryAll(detail, '.lc-skilld-head').length, 1, 'the detached seat carries the head')
    // All twenty-five generated names match 'skill' — twenty rows plus the overflow line counting the filtered set.
    await actType(input, 'skill')
    assert.equal(queryAll(m.container, 'button.lc-ov-skill').length, 20)
    assert.ok(text(m.container).includes('5 more skills'), 'the overflow counts the filtered set')
    await m.unmount()
  })

  test('the bars keep the scope’s heaviest tally as their denominator under a filter', async () => {
    const m = await mount(h(Skills, { stats: [stat('heavy', 8, NOW), stat('light', 4, NOW)], now: NOW }))
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-skills-search')
    await actType(input, 'light')
    const rows = queryAll<HTMLElement>(m.container, 'button.lc-ov-skill')
    assert.equal(rows.length, 1)
    assert.ok(query(rows[0], '.lc-ov-skill-bar').getAttribute('style')?.includes('calc(50% - 6px)'), 'the share stays against the scope’s heaviest row')
    await m.unmount()
  })

  test('zh locale renders the shipped strings', async () => {
    const m = await mount(h(SkillsZh, {
      stats: [stat('tdd', 2, NOW - 2 * 3_600_000)],
      selected: 'tdd',
      catalog: CATALOG,
      now: NOW,
    }))
    assert.ok(text(m.container).includes('技能加载'))
    assert.ok(text(m.container).includes('1 个技能 · 2 次加载'), 'the zh summary sub')
    assert.ok(text(m.container).includes('2 小时前'))
    const detail = query(m.container, '.lc-ov-skill-detail')
    assert.deepEqual(queryAll(detail, '.lc-skilld-k').map(k => text(k)), ['来源', '用量', '最近', '路径'])
    const values = queryAll(detail, '.lc-skilld-v')
    assert.equal(text(values[0]), '用户')
    assert.ok(text(values[1]).includes('2 次加载 · 1 个会话'))
    assert.equal(query(m.container, '.lc-skilld-pathv').getAttribute('data-lc-tip'), '点击复制路径')
    await hover(query(m.container, 'button.lc-ov-skill'))
    assert.equal(text(query(bubble()!, '.lc-skilld-hint')), '再次点击取消筛选', 'the pinned row’s zh hint')
    await m.unmount()
    const empty = await mount(h(SkillsZh, { stats: [], now: NOW }))
    assert.ok(text(empty.container).includes('暂无技能加载'))
    await empty.unmount()
  })
})

/** Type into an input through the React change path (native setter + input event, act-wrapped). */
async function actType(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
