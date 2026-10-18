// revealScroll (src/client/revealScroll.ts) — the jump's landing reveal against real jsdom DOM: the nearest
// ancestor that ACTUALLY scrolls (overflowing style alone is not enough) takes the rect-delta scroll.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { revealInScrollParent, revealRowInCard } from '../../src/client/revealScroll'

/** A viewport rect carrying only the top the reveal reads. */
const top = (t: number): DOMRect => ({ top: t }) as DOMRect

/** An overflow-styled scroller holding the anchor, stubbed with real overflow and viewport tops. */
function mounted(oy: 'auto' | 'scroll', scrollerTop: number, anchorTop: number): { scroller: HTMLDivElement; anchor: HTMLDivElement } {
  const scroller = document.createElement('div')
  scroller.style.overflowY = oy
  // jsdom reports 0 for both — an operative scroller must overflow its box.
  Object.defineProperty(scroller, 'scrollHeight', { value: 500 })
  Object.defineProperty(scroller, 'clientHeight', { value: 200 })
  scroller.getBoundingClientRect = () => top(scrollerTop)
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => top(anchorTop)
  scroller.appendChild(anchor)
  document.body.appendChild(scroller)
  return { scroller, anchor }
}

describe('revealInScrollParent', () => {
  test("scrolls the nearest 'auto' ancestor so the anchor tops its scrollport", () => {
    const { scroller, anchor } = mounted('auto', 100, 450)
    scroller.scrollTop = 42
    assert.equal(revealInScrollParent(anchor), true)
    assert.equal(scroller.scrollTop, 392, 'the rect delta lands the anchor flush: 42 + (450 − 100)')
    scroller.remove()
  })

  test("an overflow-y 'scroll' ancestor is taken the same way", () => {
    const { scroller, anchor } = mounted('scroll', 0, 200)
    assert.equal(revealInScrollParent(anchor), true)
    assert.equal(scroller.scrollTop, 200)
    scroller.remove()
  })

  test('a grow-with-content box (auto yet never overflowing) is skipped for the real scroller above', () => {
    // The Context tab's own `.lc-root` shape on layouts where an OUTER
    // container scrolls: styled auto, scrollHeight == clientHeight — taking
    // it would scroll a no-op while the real scroller waits above.
    const { scroller, anchor } = mounted('auto', 0, 300)
    const grown = document.createElement('div')
    grown.style.overflowY = 'auto'
    Object.defineProperty(grown, 'scrollHeight', { value: 300 })
    Object.defineProperty(grown, 'clientHeight', { value: 300 })
    grown.appendChild(anchor)
    scroller.appendChild(grown)
    assert.equal(revealInScrollParent(anchor), true)
    assert.equal(scroller.scrollTop, 300, 'the real scroller above takes the delta')
    scroller.remove()
  })

  test('a plain ancestor chain to body scrolls nothing and reports false', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    assert.equal(revealInScrollParent(anchor), false)
    anchor.remove()
  })

  test('a detached anchor bottoms out at the null parent: false', () => {
    assert.equal(revealInScrollParent(document.createElement('div')), false)
  })

  test('a hostile chain never throws', () => {
    const hostile = {
      get parentElement(): never { throw new Error('boom') },
    } as unknown as Element
    assert.equal(revealInScrollParent(hostile), false)
  })
})

describe('revealRowInCard', () => {
  const rect = (t: number, b: number): DOMRect => ({ top: t, bottom: b }) as DOMRect

  /** page > card > region > row: the region overflows (the card's rows region), every box has a fixed
   * viewport rect, and the page — above the card — rides its own scroll to prove nothing above moves. */
  function mounted(rowTop: number, rowBottom: number, regionOverflow = true): {
    page: HTMLDivElement; card: HTMLDivElement; region: HTMLDivElement; row: HTMLDivElement
  } {
    const page = document.createElement('div')
    const card = document.createElement('div')
    const region = document.createElement('div')
    const row = document.createElement('div')
    region.appendChild(row)
    card.appendChild(region)
    page.appendChild(card)
    document.body.appendChild(page)
    Object.defineProperty(region, 'scrollHeight', { value: regionOverflow ? 600 : 300 })
    Object.defineProperty(region, 'clientHeight', { value: regionOverflow ? 200 : 300 })
    region.getBoundingClientRect = () => rect(0, 200)
    row.getBoundingClientRect = () => rect(rowTop, rowBottom)
    // Off-zero so both scroll directions land in-range (jsdom clamps scrollTop at the bounds).
    region.scrollTop = 30
    page.scrollTop = 55
    return { page, card, region, row }
  }

  test('a row above the visible slice scrolls the rows region down to it', () => {
    const { page, region, row } = mounted(-10, 20)
    revealRowInCard(region.parentElement, row)
    assert.equal(region.scrollTop, 20, 'the row reaches the slice top: 30 − (0 − (−10))')
    assert.equal(page.scrollTop, 55, 'nothing above the card moves')
  })

  test('a row below the visible slice scrolls the rows region up to it', () => {
    const { region, row } = mounted(250, 280)
    revealRowInCard(region.parentElement, row)
    assert.equal(region.scrollTop, 110, 'the row reaches the slice bottom: 30 + (280 − 200)')
  })

  test('a fully visible row scrolls nothing', () => {
    const { page, region, row } = mounted(10, 60)
    revealRowInCard(region.parentElement, row)
    assert.equal(region.scrollTop, 30)
    assert.equal(page.scrollTop, 55)
  })

  test('a region that does not overflow ends the walk at the card: nothing moves', () => {
    const { page, card, region, row } = mounted(250, 280, false)
    revealRowInCard(card, row)
    assert.equal(region.scrollTop, 30)
    assert.equal(card.scrollTop, 0)
    assert.equal(page.scrollTop, 55)
  })

  test('a null card or row, or a row outside the card, does nothing', () => {
    const { card, row } = mounted(0, 10)
    const stranger = document.createElement('div')
    document.body.appendChild(stranger)
    assert.doesNotThrow(() => {
      revealRowInCard(null, row)
      revealRowInCard(card, null)
      revealRowInCard(card, stranger)
    })
    stranger.remove()
  })
})
