import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { BASELINE_DSH_VERSION, meetsBaseline, parseVersion } from '../../src/shared/version'

describe('parseVersion', () => {
  test('parses plain releases, channels, serials, v-prefixes and build metadata', () => {
    assert.deepEqual(parseVersion('0.1.2-rc.1'), { major: 0, minor: 1, patch: 2, rank: 3, serial: 1 })
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, rank: 4, serial: 0 })
    assert.deepEqual(parseVersion('v2.0.0-alpha'), { major: 2, minor: 0, patch: 0, rank: 1, serial: 0 })
    assert.deepEqual(parseVersion('0.1.2-beta.3'), { major: 0, minor: 1, patch: 2, rank: 2, serial: 3 })
    assert.deepEqual(parseVersion(' 0.1.2-RC.2 '), { major: 0, minor: 1, patch: 2, rank: 3, serial: 2 })
    assert.deepEqual(parseVersion('1.0.0+build.5'), { major: 1, minor: 0, patch: 0, rank: 4, serial: 0 })
  })

  test('rejects non-semver strings', () => {
    for (const bad of ['', 'abc', '1.2', '1.2.3.4', '1.2.3-nightly', '1.2.3-rc.x', '0.0.0-dev', 'v1.2.3.4-something']) {
      assert.equal(parseVersion(bad), null, bad)
    }
  })
})

describe('meetsBaseline', () => {
  test(`the supported baseline is ${BASELINE_DSH_VERSION}`, () => {
    assert.equal(BASELINE_DSH_VERSION, '0.1.7-rc.2')
  })

  test('baseline and above pass; anything below fails', () => {
    assert.equal(meetsBaseline('0.1.7-rc.2'), true, 'the baseline itself')
    assert.equal(meetsBaseline('0.1.7-rc.3'), true)
    assert.equal(meetsBaseline('0.1.7'), true, 'the final release of the baseline line')
    assert.equal(meetsBaseline('0.2.0-rc.2'), true, 'the newest supported line')
    assert.equal(meetsBaseline('0.2.0-alpha.1'), true, 'a newer X.Y.Z outranks any channel (the 0.2.0 previews pass)')
    assert.equal(meetsBaseline('1.0.0-alpha.1'), true, 'a newer major outranks everything below it')
    assert.equal(meetsBaseline('0.1.7-rc.1'), false, 'an older rc of the baseline line')
    assert.equal(meetsBaseline('0.1.7-alpha.1'), false, 'alpha is below rc at equal X.Y.Z')
    assert.equal(meetsBaseline('0.1.6'), false, 'a hypothetical final of the dropped cycle')
    assert.equal(meetsBaseline('0.1.5-rc.1'), false, 'the previous floor, now gated')
    assert.equal(meetsBaseline('0.1.2-rc.1'), false)
    assert.equal(meetsBaseline('0.0.9'), false)
  })

  test('fails open: an unparseable version (or baseline) never gates', () => {
    assert.equal(meetsBaseline('0.0.0-dev'), true)
    assert.equal(meetsBaseline('not-a-version'), true)
    assert.equal(meetsBaseline('0.1.0', 'also-junk'), true)
  })

  test('accepts an explicit baseline', () => {
    assert.equal(meetsBaseline('0.1.5-rc.1', '0.2.0'), false)
    assert.equal(meetsBaseline('0.2.0', '0.2.0-alpha.1'), true)
  })
})
