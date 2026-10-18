// The auto-compaction reserve geometry (src/client/reserve.ts): dsh-compaction-basic's pressure
// trigger priced against the session's real window and routed output cap, plus the mask extents the
// composition bar paints. The masks tile the window's tail [window − output − headroom, window] at
// their true sizes; the trigger sits at or left of the headroom mask's left edge.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { COMPACT_HEADROOM_TOKENS, COMPACT_THRESHOLD_RATIO, reserveGeometry } from '../../src/client/reserve'

/** The trigger never crosses the masks: it IS the headroom mask's left edge when the pressure
 *  budget binds, and sits strictly left of it when the window fraction binds. */
function triggerAtOrLeftOfMasks(reserve: NonNullable<ReturnType<typeof reserveGeometry>>, window: number): boolean {
  return reserve.threshold <= window - reserve.output - reserve.headroom
}

describe('reserveGeometry', () => {
  test('no positive window: no reserve', () => {
    assert.equal(reserveGeometry(undefined, 256_000), undefined)
    assert.equal(reserveGeometry(0, 256_000), undefined)
    assert.equal(reserveGeometry(-1_000, 256_000), undefined)
    assert.equal(reserveGeometry(Number.NaN, 256_000), undefined)
    assert.equal(reserveGeometry(Number.POSITIVE_INFINITY, 256_000), undefined)
  })

  test('the deepseek defaults: the pressure budget binds, and the trigger is the masks\' left edge', () => {
    // W = 1,000,000, O = 256,000 (the routed envelope cap), B = 65,536 (dsh's default):
    // threshold = min(floor(W × 0.8), W − O − B) = min(800,000, 678,464).
    const reserve = reserveGeometry(1_000_000, 256_000)
    assert.deepEqual(reserve, { threshold: 678_464, headroom: COMPACT_HEADROOM_TOKENS, output: 256_000 })
    assert.ok(triggerAtOrLeftOfMasks(reserve!, 1_000_000))
  })

  test('a small output cap leaves the ratio binding: the trigger detaches, the headroom keeps its true size', () => {
    // threshold = min(800,000, 926,464) = 800,000 — strictly left of the masks' 926,464 edge.
    const reserve = reserveGeometry(1_000_000, 8_000)
    assert.deepEqual(reserve, { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 8_000 })
    assert.equal(reserve!.threshold, Math.floor(1_000_000 * COMPACT_THRESHOLD_RATIO))
    assert.ok(triggerAtOrLeftOfMasks(reserve!, 1_000_000))
  })

  test('an unknown, non-positive, or non-finite output cap reserves no output', () => {
    // No output reservation, so the ratio binds at 800,000 and the headroom mask stands alone.
    const expected = { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 0 }
    for (const cap of [undefined, 0, -8_000, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      assert.deepEqual(reserveGeometry(1_000_000, cap), expected, String(cap))
    }
    // The wire can carry any type: a non-number cap reserves nothing rather than poisoning the math.
    assert.deepEqual(reserveGeometry(1_000_000, 'junk' as unknown as number), expected)
  })

  test('a window too small to hold the headroom reserves nothing, as dsh refuses that route', () => {
    // W − O − headroom ≤ 0: `resolveCompactSpec` throws TargetPressureConfigError and pressure
    // compaction never runs, so painting a trigger would be a lie — the masks stay off.
    assert.equal(reserveGeometry(65_536, 0), undefined) // exactly the boundary
    assert.equal(reserveGeometry(65_535, 0), undefined)
    // A window too small even to hold the output reservation.
    assert.equal(reserveGeometry(1_000, 200), undefined)
    assert.equal(reserveGeometry(1_000, 1_000), undefined)
    assert.equal(reserveGeometry(1_000, 5_000), undefined)
    // One token of budget survives, so the masks come back — the headroom is exactly dsh's default.
    const tight = reserveGeometry(65_537, 0)
    assert.deepEqual(tight, { threshold: 1, headroom: COMPACT_HEADROOM_TOKENS, output: 0 })
    assert.ok(triggerAtOrLeftOfMasks(tight!, 65_537))
  })
})
