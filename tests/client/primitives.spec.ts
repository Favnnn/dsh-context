// The defensive icon resolver (src/client/primitives.ts): each ui-primitives icon resolves by its export name;
// a name missing from the module (a future rename) or a namespace that throws on the read degrades to a
// render-nothing component instead of the React #130 element-type crash.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FileTypeGlyph, resolveFileGlyph, resolveIcon, IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown } from '../../src/client/primitives'

describe('resolveIcon', () => {
  const icon = function SomeIcon(): null { return null }

  test('a present export resolves to the component', () => {
    assert.equal(resolveIcon('icon', { icon }), icon)
  })

  test('a name present but not a component renders nothing', () => {
    const resolved = resolveIcon('icon', { icon: 42 })
    assert.equal(resolved({}), null, 'the fallback component renders null')
  })

  test('a missing name renders nothing (a future rename)', () => {
    const resolved = resolveIcon('IconGhostOutlineRegular', {})
    assert.equal(resolved({}), null)
  })

  test('a namespace that throws on property access degrades to the fallback', () => {
    // Partial module mocks and hostile namespaces throw on the READ itself.
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    const resolved = resolveIcon('IconBranchOutlineRegular', hostile)
    assert.equal(resolved({}), null)
  })

  test('the module-level exports resolve against the pinned generation', () => {
    // The devDep carries the supported vocabulary, so these resolved at module load.
    for (const icon of [IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown]) {
      assert.equal(typeof icon, 'function', 'every seam resolves to a component')
    }
    assert.equal(typeof FileTypeGlyph, 'function', 'the file-type glyph resolves too')
  })
})

describe('resolveFileGlyph', () => {
  const glyph = function SomeGlyph(): null { return null }

  test('a present export resolves; a missing, non-component, or hostile read renders nothing', () => {
    assert.equal(resolveFileGlyph({ FileTypeIcon: glyph }), glyph)
    assert.equal(resolveFileGlyph({ FileTypeIcon: 42 })({}), null)
    assert.equal(resolveFileGlyph({})({}), null)
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    assert.equal(resolveFileGlyph(hostile)({}), null)
  })
})
