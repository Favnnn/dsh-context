import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  DAY_KEY_RE,
  MONTH_KEY_RE,
  dayKeyOf,
  endOfDayKey,
  monthGridOf,
  shiftDayKey,
  shiftMonthKey,
  startOfDayKey,
  sundayOfWeek,
  weekdayOf,
} from '../../src/shared/days'

describe('dayKeyOf', () => {
  test('keys a local instant as YYYY-MM-DD with zero padding', () => {
    // Local noon is deterministic in every timezone.
    assert.equal(dayKeyOf(new Date(2026, 8, 16, 12).getTime()), '2026-09-16')
    assert.equal(dayKeyOf(new Date(2026, 0, 5, 12).getTime()), '2026-01-05')
    assert.equal(dayKeyOf(new Date(2026, 11, 25, 12).getTime()), '2026-12-25')
  })

  test('keys local midnight to the new day', () => {
    assert.equal(dayKeyOf(new Date(2026, 0, 2, 0, 0, 0).getTime()), '2026-01-02')
  })

  test('non-finite and out-of-range instants key null', () => {
    assert.equal(dayKeyOf(Number.NaN), null)
    assert.equal(dayKeyOf(Number.POSITIVE_INFINITY), null)
    assert.equal(dayKeyOf(1e30), null, 'outside the representable date range')
    assert.equal(dayKeyOf(-2 * 86_400_000), null, 'before the epoch in every timezone')
    assert.equal(dayKeyOf(new Date(10000, 0, 1).getTime()), null, 'past the four-digit year')
  })
})

describe('shiftDayKey', () => {
  test('advances and retreats across month and year boundaries', () => {
    assert.equal(shiftDayKey('2026-09-16', 1), '2026-09-17')
    assert.equal(shiftDayKey('2026-09-16', -1), '2026-09-15')
    assert.equal(shiftDayKey('2026-01-31', 1), '2026-02-01')
    assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28')
    assert.equal(shiftDayKey('2027-01-01', -1), '2026-12-31')
    assert.equal(shiftDayKey('2024-02-28', 1), '2024-02-29', 'leap day kept')
  })

  test('malformed keys yield null instead of a rolled-over date', () => {
    assert.equal(shiftDayKey('garbage', 1), null)
    assert.equal(shiftDayKey('2026-13-01', 1), null, 'month 13 would roll over')
    assert.equal(shiftDayKey('2026-02-30', 1), null, 'February 30th does not exist')
    assert.equal(shiftDayKey('2026-9-6', 1), null, 'unpadded fields fail the shape')
  })
})

describe('sundayOfWeek', () => {
  test('every weekday maps to its week’s Sunday (2026-09-13 was one)', () => {
    assert.equal(sundayOfWeek('2026-09-13'), '2026-09-13', 'Sunday itself')
    assert.equal(sundayOfWeek('2026-09-16'), '2026-09-13', 'Wednesday')
    assert.equal(sundayOfWeek('2026-09-19'), '2026-09-13', 'Saturday belongs to the same Sunday-first week')
    assert.equal(sundayOfWeek('2026-09-20'), '2026-09-20', 'the next week starts Sunday')
  })

  test('malformed keys yield null', () => {
    assert.equal(sundayOfWeek('junk'), null)
    assert.equal(sundayOfWeek('2026-02-30'), null)
  })
})

describe('DAY_KEY_RE', () => {
  test('matches the emitted shape only', () => {
    assert.equal(DAY_KEY_RE.test('2026-09-16'), true)
    assert.equal(DAY_KEY_RE.test('2026-9-16'), false)
    assert.equal(DAY_KEY_RE.test('2026-09-16T00:00:00'), false)
  })
})

describe('startOfDayKey / endOfDayKey', () => {
  test('a picked range spans the whole local day', () => {
    // Endpoints, not a duration: a DST-short day is 23 hours long, so the difference is not a fixed number of milliseconds.
    assert.equal(startOfDayKey('2026-09-16'), new Date(2026, 8, 16, 0, 0, 0, 0).getTime())
    assert.equal(endOfDayKey('2026-09-16'), new Date(2026, 8, 16, 23, 59, 59, 999).getTime())
    assert.equal(startOfDayKey('2026-03-08'), new Date(2026, 2, 8, 0, 0, 0, 0).getTime(), 'a DST-short day still opens on its own midnight')
  })

  test('malformed keys yield null', () => {
    assert.equal(startOfDayKey('2026-02-30'), null)
    assert.equal(endOfDayKey('nope'), null)
  })
})

describe('shiftMonthKey', () => {
  test('steps across month and year boundaries', () => {
    assert.equal(shiftMonthKey('2026-10', 1), '2026-11')
    assert.equal(shiftMonthKey('2026-10', -1), '2026-09')
    assert.equal(shiftMonthKey('2026-12', 1), '2027-01')
    assert.equal(shiftMonthKey('2026-01', -1), '2025-12')
    assert.equal(shiftMonthKey('2026-10', 14), '2027-12')
  })

  test('malformed keys and out-of-range targets yield null', () => {
    assert.equal(shiftMonthKey('2026-13', 1), null)
    assert.equal(shiftMonthKey('2026-00', 1), null)
    assert.equal(shiftMonthKey('2026-1', 1), null)
    assert.equal(shiftMonthKey('junk', 1), null)
    assert.equal(shiftMonthKey('1970-01', -1), null, 'before the representable range')
    assert.equal(shiftMonthKey('9999-12', 1), null, 'past the representable range')
  })
})

describe('weekdayOf', () => {
  test('returns the local weekday index, 0 = Sunday', () => {
    assert.equal(weekdayOf('2026-09-13'), 0)
    assert.equal(weekdayOf('2026-09-16'), 3)
    assert.equal(weekdayOf('2026-09-19'), 6)
    assert.equal(weekdayOf('2026-02-30'), null)
  })
})

describe('monthGridOf', () => {
  test('lays a month out as Sunday-first weeks of seven cells', () => {
    const grid = monthGridOf('2026-09')
    assert.ok(grid !== null)
    assert.equal(grid[0].length, 7)
    assert.deepEqual(grid[0].slice(0, 3), [null, null, '2026-09-01'])
    assert.equal(grid[0][6], '2026-09-05')
    const last = grid[grid.length - 1]
    assert.deepEqual(last.filter((k) => k !== null), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'], 'the open week is padded, never half-filled')
    const days = grid.flat().filter((k) => k !== null)
    assert.equal(days.length, 30)
    assert.equal(days.every((k) => k.startsWith('2026-09')), true)
  })

  test('a month that opens on Sunday needs no lead blank', () => {
    const nov = monthGridOf('2026-11')
    assert.ok(nov !== null)
    assert.equal(nov[0][0], '2026-11-01')
    assert.equal(nov[0].filter((k) => k !== null).length, 7)
  })

  test('malformed months and a month that leaves the key range yield null', () => {
    assert.equal(monthGridOf('2026-13'), null)
    assert.equal(monthGridOf('junk'), null)
    // The last representable month still grids; stepping past it (shiftMonthKey) is what yields null.
    assert.ok(monthGridOf('9999-12') !== null)
  })
})

describe('MONTH_KEY_RE', () => {
  test('matches the emitted shape only', () => {
    assert.equal(MONTH_KEY_RE.test('2026-10'), true)
    assert.equal(MONTH_KEY_RE.test('2026-1'), false)
    assert.equal(MONTH_KEY_RE.test('2026-10-01'), false)
  })
})
