import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { browserCapOf } from '../../../src/client/components/contextView'

describe('browserCapOf — the Context browser column\'s height ceiling', () => {
  test('the span from the first left card\'s top to the last card\'s bottom, rounded UP', () => {
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609 }]), 509)
    // A fractional span rounds up: the card is never shorter than the cards beside it.
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609.4 }]), 510)
  })

  test('no measurable card (the loading frame) leaves the column uncapped', () => {
    assert.equal(browserCapOf([]), null)
  })

  test('a degenerate span leaves the column uncapped', () => {
    assert.equal(browserCapOf([{ top: 0, bottom: 0 }]), null)
    assert.equal(browserCapOf([{ top: 10, bottom: 5 }]), null)
  })

  test('a non-finite rect (a layout-less stub) leaves the column uncapped, not NaN', () => {
    assert.equal(browserCapOf([{ top: Number.NaN, bottom: 10 }]), null)
    assert.equal(browserCapOf([{ top: 0, bottom: undefined as unknown as number }]), null)
  })
})
