import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import {
  makeDateRange,
  monthLabelOf,
  type DateRangeProps,
} from '../../../src/client/components/dateRange'
import type { DayRange } from '../../../src/client/overview'
import { click, hover, keydown, makeKit, mount, query, queryAll, text, type Mounted } from '../helpers/kit'

/** The specs' calendar: a Friday, so the month opens mid-week and ends mid-week. */
const TODAY = '2026-10-09'

const DateRange = makeDateRange(makeKit())

/** Every tree this spec mounted, torn down after each test (the panel portals to <body>). */
const mounted: Mounted[] = []

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lc-dp-panel')
}

function trigger(m: Mounted): HTMLElement {
  return query(m.container, '.lc-dp-trigger')
}

function cell(m: Mounted, key: string): HTMLElement {
  const found = queryAll(document.body, '.lc-dp-cell').find(el => el.getAttribute('aria-label') === key)
  if (found === undefined) throw new Error(`no day cell: ${key}`)
  return found
}

/** Dispatch a raw event on a window listener, act-wrapped like the kit's own relays. */
async function fireWindow(ev: Event): Promise<void> {
  await act(async () => { window.dispatchEvent(ev) })
}

interface Harness {
  m: Mounted
  changes: (DayRange | null)[]
  /** Re-render with new props, as a controlled parent would. */
  set: (next: Partial<DateRangeProps>) => Promise<void>
}

async function open(over: Partial<DateRangeProps> = {}): Promise<Harness> {
  const changes: (DayRange | null)[] = []
  let props: DateRangeProps = {
    value: null,
    picked: false,
    onChange: (range) => { changes.push(range) },
    today: TODAY,
    locale: 'en',
    ...over,
  }
  const m = await mount(h(DateRange, props))
  mounted.push(m)
  return {
    m,
    changes,
    async set(next) {
      props = { ...props, ...next }
      await m.update(h(DateRange, props))
    },
  }
}

async function toggle(m: Mounted): Promise<void> {
  await click(trigger(m))
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.unmount()
})

describe('monthLabelOf', () => {
  test('the panel header names the month in the active locale', () => {
    assert.match(monthLabelOf('2026-10', 'en'), /2026/)
    assert.match(monthLabelOf('2026-10', 'zh'), /2026/)
    assert.equal(monthLabelOf('not-a-month', 'en'), 'not-a-month', 'a key that will not convert falls back to itself')
  })
})

describe('the trigger', () => {
  test('carries the scope’s two ends, or the two placeholders', async () => {
    const { m, set } = await open()
    const halves = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    assert.deepEqual(halves(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.match(query(m.container, '.lc-dp-trigger').getAttribute('aria-label') ?? '', /custom date range/)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    await toggle(m)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
    assert.ok(panel() !== null, 'the panel is portaled to the body')

    // A preset's window rides the chip too — linked, but never in the brand
    // voice and with no way back, because a preset is not a pick.
    await set({ value: { from: '2026-09-10', to: '2026-10-09' } })
    assert.deepEqual(halves(), ['2026-09-10', '2026-10-09'])
    assert.ok(!trigger(m).className.includes('lc-dp-trigger-on'))
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 0, 'nothing to clear while a preset is in charge')

    await set({ picked: true })
    assert.match(trigger(m).className, /lc-dp-trigger-on/)
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 1, 'a pick grows the way back')
  })

  test('a press while open closes it again', async () => {
    const { m } = await open()
    await toggle(m)
    await toggle(m)
    assert.ok(panel() === null)
  })
})

describe('picking a range', () => {
  test('two clicks in order commit the pair and close the panel', async () => {
    const { m, changes } = await open()
    await toggle(m)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/)
    await click(cell(m, '2026-10-03'))
    assert.deepEqual(changes, [], 'the first click only anchors')
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
    assert.match(cell(m, '2026-10-03').className, /lc-dp-edge/, 'the anchor is the start until the end lands')
    assert.match(text(query(m.container, '.lc-dp-half')), /2026-10-03/, 'the head reads the anchor as it lands')

    await hover(cell(m, '2026-10-09'))
    assert.match(text(queryAll(m.container, '.lc-dp-half')[1]), /2026-10-09/, 'the head previews the end under the cursor')
    await click(cell(m, '2026-10-09'))
    assert.deepEqual(changes, [{ from: '2026-10-03', to: '2026-10-09' }])
    assert.ok(panel() === null, 'the pick answers the page immediately')
  })

  test('the end may come first: the pair is sorted, never inverted', async () => {
    const { m, changes } = await open()
    await toggle(m)
    await click(cell(m, '2026-10-09'))
    await click(cell(m, '2026-10-03'))
    assert.deepEqual(changes, [{ from: '2026-10-03', to: '2026-10-09' }])
  })

  test('the same day twice is a one-day range', async () => {
    const { m, changes } = await open()
    await toggle(m)
    await click(cell(m, '2026-10-05'))
    await click(cell(m, '2026-10-05'))
    assert.deepEqual(changes, [{ from: '2026-10-05', to: '2026-10-05' }])
  })

  test('the band previews under the cursor once the start is anchored', async () => {
    const { m } = await open()
    await toggle(m)
    await click(cell(m, '2026-10-03'))
    assert.match(cell(m, '2026-10-03').className, /lc-dp-edge/, 'the anchor alone lights up as an edge')
    await hover(cell(m, '2026-10-07'))
    assert.match(cell(m, '2026-10-05').className, /lc-dp-in/, 'the band runs to the hovered day')
    assert.match(cell(m, '2026-10-07').className, /lc-dp-edge/, 'the hovered day previews where the end would land')
    await hover(cell(m, '2026-10-01'))
    assert.match(cell(m, '2026-10-02').className, /lc-dp-in/, 'hovering back past the anchor previews the swapped band')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-edge/, 'the swap moves the previewed end to the near side')
  })

  test('a hover before any anchor previews nothing', async () => {
    const { m } = await open()
    await toggle(m)
    const before = cell(m, '2026-10-07').className
    await hover(cell(m, '2026-10-07'))
    assert.equal(cell(m, '2026-10-07').className, before)
  })

  test('the live scope is highlighted when the panel opens, and a click restarts the pick', async () => {
    const { m } = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(m)
    assert.match(cell(m, '2026-10-04').className, /lc-dp-in/)
    assert.match(cell(m, '2026-10-03').className, /lc-dp-edge/)
    assert.match(cell(m, '2026-10-06').className, /lc-dp-edge/)
    assert.match(cell(m, '2026-10-09').className, /lc-dp-today/)
    assert.match(cell(m, '2026-10-07').textContent ?? '', /^7$/, 'each cell prints its own day of the month')
    // Clicking anywhere restarts the pick, so the old band releases.
    await click(cell(m, '2026-10-08'))
    assert.equal(cell(m, '2026-10-04').className.includes('lc-dp-in'), false)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
  })

  test('a preset’s window is the band on show, with no second copy of its dates', async () => {
    const { m } = await open({ value: { from: '2026-10-03', to: '2026-10-09' } })
    await toggle(m)
    assert.match(cell(m, '2026-10-05').className, /lc-dp-in/, 'the preset’s own days show as the live band')
    assert.equal(queryAll(panel()!, '.lc-dp-box').length, 0, 'the chip above is the only place the ends are printed')
    assert.equal(queryAll(panel()!, '.lc-dp-pair').length, 0)
  })

  test('a future day is inert and a blank pad cell is inert', async () => {
    const { m, changes } = await open()
    await toggle(m)
    const future = cell(m, '2026-10-10')
    assert.match(future.className, /lc-dp-future/)
    assert.equal(future.getAttribute('aria-disabled'), 'true')
    await click(future)
    assert.deepEqual(changes, [])
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/, 'the future day did not anchor')
    await hover(future)
    assert.ok(queryAll(panel()!, '.lc-dp-blank').length > 0, 'the month pads its weeks')
  })

  test('the clear button hands the scope back to the presets', async () => {
    const { m, changes } = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(m)
    await click(query(panel()!, '.lc-dp-clear'))
    assert.deepEqual(changes, [null])
  })

  test('no clear button while nothing is picked', async () => {
    const { m } = await open()
    await toggle(m)
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 0)
  })
})

describe('the month nav', () => {
  test('steps a month at a time and stops at this month', async () => {
    const { m } = await open()
    await toggle(m)
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /2026/)
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'the panel opens on this month, so next is spent')

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), false, 'back a month, next serves again')
    await click(queryAll(panel()!, '.lc-dp-navbtn')[1])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'no month past this one')
    assert.equal(queryAll(panel()!, '.lc-dp-cell').length > 0, true)
  })

  test('the panel always comes back on this month, not the browsed one', async () => {
    const { m } = await open()
    await toggle(m)
    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    const away = query(panel()!, '.lc-dp-month').textContent
    await toggle(m)
    await toggle(m)
    assert.notEqual(query(panel()!, '.lc-dp-month').textContent, away, 'the panel came back on today, not the browsed month')
  })

  test('the earliest representable month cannot step back', async () => {
    const { m } = await open({ today: '1970-01-05' })
    await toggle(m)
    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /1970/)
  })

  test('a malformed today opens no panel and claims no expansion', async () => {
    const { m } = await open({ today: 'garbage' })
    await toggle(m)
    assert.ok(panel() === null)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false', 'nothing rendered, so nothing reported as open')
  })
})

describe('the keyboard cursor', () => {
  test('arrows walk the shown month and Enter picks the day under them', async () => {
    const { m, changes } = await open()
    await toggle(m)
    const grid = query(panel()!, '.lc-dp-grid')
    assert.equal(grid.getAttribute('aria-activedescendant'), 'lc-dp-day')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor opens on the month’s first day')

    await keydown('ArrowRight', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid)
    assert.match(cell(m, '2026-10-09').className, /lc-dp-cursor/)
    await keydown('ArrowUp', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowLeft', grid)
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/)

    await keydown('Enter', grid)
    await keydown(' ', grid)
    assert.deepEqual(changes, [{ from: '2026-10-01', to: '2026-10-01' }], 'Enter anchors, Space closes the pair')
  })

  test('the cursor never leaves the shown month or enters the future', async () => {
    const { m } = await open()
    await toggle(m)
    const grid = () => query(panel()!, '.lc-dp-grid')
    // The 1st is a Thursday; a week up from it would leave October.
    await keydown('ArrowUp', grid())
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor stays inside the shown month')
    // Rightward it walks, and today is the last stop — the future is not a seat.
    for (let i = 0; i < 40; i++) await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)
    await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(cell(m, '2026-09-01').className, /lc-dp-cursor/, 'a month step re-seats the cursor on the 1st')
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-08').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-15').className, /lc-dp-cursor/)
  })

  test('any other key is left to the page', async () => {
    const { m } = await open()
    await toggle(m)
    const grid = query(panel()!, '.lc-dp-grid')
    await keydown('Tab', grid)
    await keydown('a', grid)
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/)
  })
})

describe('the panel seat', () => {
  test('sits under its trigger, inside the viewport, and flips when it would fall off', async () => {
    // jsdom measures every element as 0; drive the panel's own box, then put
    // the prototype's own descriptors back (deleting them would leave every later measurement NaN).
    const size = { w: 240, h: 300 }
    const own = (name: string): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const width = own('offsetWidth')
    const height = own('offsetHeight')
    const restore = (name: string, was: PropertyDescriptor | undefined): void => {
      if (was === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
      else Object.defineProperty(HTMLElement.prototype, name, was)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => size.w })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => size.h })
    try {
      const { m } = await open()
      // The panel measures its anchor wrapper (the trigger's own box): jsdom's rects are all zeros, so drive the one it reads.
      const rect = { left: 800, right: 900, top: 680, bottom: 700 }
      query(m.container, '.lc-dp').getBoundingClientRect = () =>
        ({ ...rect, x: rect.left, y: rect.top, width: 100, height: 20, toJSON: () => '' }) as DOMRect

      await toggle(m)
      const seated = panel()!
      assert.equal(seated.style.left, '660px', 'right-aligned to the trigger')
      assert.equal(seated.style.top, '374px', 'flipped above: below the trigger there is no room for 300px')

      rect.left = 10
      rect.right = 110
      await toggle(m)
      await toggle(m)
      const clamped = panel()!
      assert.equal(clamped.style.left, '8px', 'clamped inside the viewport')
      assert.equal(clamped.style.top, '374px')
    } finally {
      restore('offsetWidth', width)
      restore('offsetHeight', height)
    }
  })

  test('renders hidden until it has measured itself', async () => {
    const { m } = await open()
    await toggle(m)
    // The layout effect measures before paint, so the seated panel is what a
    // reader ever sees; a fresh mount would flash at (0, 0) without it.
    assert.equal(panel()!.style.visibility, '')
    assert.notEqual(panel()!.style.left, '0px')
  })
})

describe('leaving the panel', () => {
  test('Escape closes it and puts focus back on the trigger', async () => {
    const { m } = await open()
    await toggle(m)
    trigger(m).focus()
    await keydown('Escape')
    assert.ok(panel() === null)
    assert.equal(document.activeElement?.className, trigger(m).className, 'focus comes back to the trigger')
  })

  test('a press outside closes it; a press inside does not', async () => {
    const { m } = await open()
    await toggle(m)
    await act(async () => { query(m.container, '.lc-dp').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'the tree the panel was opened from stays open')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() === null)
  })

  test('a press inside the panel is not an outside press', async () => {
    const { m } = await open()
    await toggle(m)
    await act(async () => { cell(m, '2026-10-03').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null)
  })

  test('a press on the trigger itself does not race the toggle', async () => {
    const { m } = await open()
    await toggle(m)
    await act(async () => { trigger(m).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null)
  })

  test('an event with no node target is ignored', async () => {
    const { m } = await open()
    await toggle(m)
    // Dispatched at window itself, so the target is not a node at all.
    await fireWindow(new MouseEvent('mousedown'))
    assert.ok(panel() !== null)
  })

  test('a scroll or a resize retracts it rather than floating off the anchor', async () => {
    const { m } = await open()
    await toggle(m)
    await fireWindow(new Event('scroll'))
    assert.ok(panel() === null)

    await toggle(m)
    await fireWindow(new Event('resize'))
    assert.ok(panel() === null)
  })
})
