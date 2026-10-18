/** Scroll an element's nearest operative scrollable ancestor so the element tops that scrollport.
 * Host-agnostic: the conversation tab scrolls a shared container, while the right Sidebar's scroller
 * differs per shell layout. False — never a throw — when no ancestor scrolls or the chain turns hostile. */

export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      // The OPERATIVE scroller, not just an overflow-styled one: a box that grows with its content
      // (the Context tab's own `.lc-root` where an outer container scrolls) reports auto yet never moves.
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        return true
      }
    }
  } catch { /* the reveal degrades to nothing */ }
  return false
}

/** Bring `row` into its nearest overflowing ancestor INSIDE `card`, and nothing above it: the card's
 * hosts — the capped tab column, the filled /context dialog — fit their pane together, so the rows
 * region is the only scroller that may move. A band scrub or row pick must never drag the page (and
 * the card's fixed head) out of view. When no region inside the card overflows, the row is already
 * fully visible and nothing moves. */
export function revealRowInCard(card: Element | null, row: Element | null): void {
  if (card === null || row === null || !card.contains(row)) return
  let scroller: HTMLElement | null = row.parentElement
  while (scroller !== null && scroller !== card && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement
  }
  /* v8 ignore next 1 -- a contained row's parent chain always reaches the card; the null bound is unreachable. */
  if (scroller === null || scroller === card) return
  const rb = row.getBoundingClientRect()
  const sb = scroller.getBoundingClientRect()
  // The row only has to reach the scrollport's VISIBLE slice: a pane usually extends below the window
  // fold, so its own box bottom is no visibility boundary.
  const visTop = Math.max(sb.top, 0)
  const visBottom = Math.min(sb.bottom, window.innerHeight)
  if (rb.top < visTop) scroller.scrollTop -= visTop - rb.top
  else if (rb.bottom > visBottom) scroller.scrollTop += rb.bottom - visBottom
}
