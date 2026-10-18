// Dictionaries (src/client/i18n.ts): non-empty values, ru key parity, and agreeing interpolation
// placeholders. Key-set parity with the zh source of truth is a compile-time invariant (satisfies
// Record<DictKey, string>), so only what types cannot see is asserted here.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_RU, DICT_ZH, type DictKey } from '../../src/client/i18n'

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

describe('dictionaries', () => {
  test('every value is a non-empty string', () => {
    for (const dict of [DICT_ZH, DICT_EN, DICT_RU]) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', key)
        assert.ok(value.length > 0, key)
      }
    }
  })

  test('the ru dictionary carries exactly the zh key set', () => {
    assert.deepEqual(Object.keys(DICT_RU).sort(), Object.keys(DICT_ZH).sort())
  })

  test('interpolation placeholders agree between locales for every key', () => {
    for (const key of Object.keys(DICT_EN) as DictKey[]) {
      // 'block.line' is the one documented asymmetry: the en and ru singular
      // forms are fixed literals ('1 line' / '1 строка') while zh keeps the
      // {n} measure word.
      if (key === 'block.line') {
        assert.deepEqual(placeholders(DICT_ZH[key]), ['n'])
        assert.deepEqual(placeholders(DICT_EN[key]), [])
        assert.deepEqual(placeholders(DICT_RU[key]), [])
        continue
      }
      const expected = placeholders(DICT_ZH[key])
      assert.deepEqual(placeholders(DICT_EN[key]), expected, key)
      assert.deepEqual(placeholders(DICT_RU[key]), expected, key)
    }
  })
})
