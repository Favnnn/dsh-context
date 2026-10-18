// The shared attachment vocabulary (src/shared/attachment.ts): both block spellings normalize into
// one proven reference, and the preview tables classify what a card can show.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  attachmentExtension,
  attachmentOf,
  attachmentsIn,
  isImageName,
  leafNameOf,
} from '../../src/shared/attachment'

describe('attachmentExtension', () => {
  test('reads the last suffix of a name or path, lower-cased', () => {
    assert.equal(attachmentExtension('report.MD'), 'md')
    assert.equal(attachmentExtension('dir/sub/file.tar.gz'), 'gz')
    assert.equal(attachmentExtension('C:\\docs\\sheet.XLSX'), 'xlsx')
  })

  test('a missing, trailing, or leading-dot suffix is empty', () => {
    assert.equal(attachmentExtension('README'), '')
    assert.equal(attachmentExtension('archive.'), '')
    assert.equal(attachmentExtension('.env'), 'env')
    assert.equal(attachmentExtension('.gitignore'), 'gitignore')
    assert.equal(attachmentExtension(''), '')
  })
})

describe('isImageName', () => {
  test('matches exactly the suffixes the preview column\'s image viewers claim', () => {
    assert.equal(isImageName('x.PNG'), true)
    assert.equal(isImageName('/dir/shot.webp'), true)
    assert.equal(isImageName('vector.svg'), true)
    assert.equal(isImageName('scan.tiff'), false, 'the column lists tiff as unviewable')
    assert.equal(isImageName('photo.avif'), false, 'the column lists avif as unviewable')
    assert.equal(isImageName('notes.md'), false)
    assert.equal(isImageName('report.docx'), false)
    assert.equal(isImageName(''), false)
  })
})

describe('leafNameOf', () => {
  test('keeps the leaf of either separator style, so a path never escapes its directory', () => {
    assert.equal(leafNameOf('/a/b/report.md'), 'report.md')
    assert.equal(leafNameOf('C:\\tmp\\x.png'), 'x.png')
    assert.equal(leafNameOf('report.md'), 'report.md')
    assert.equal(leafNameOf(''), '')
  })
})

describe('attachmentOf', () => {
  test('rejects every non-attachment block', () => {
    assert.equal(attachmentOf(null), null)
    assert.equal(attachmentOf('image'), null)
    assert.equal(attachmentOf(42), null)
    assert.equal(attachmentOf({}), null)
    assert.equal(attachmentOf({ type: 'text', attachment: { attachmentId: 'a' } }), null)
    assert.equal(attachmentOf({ kind: 'mystery', attachment: { attachmentId: 'a' } }), null)
  })

  test('rejects a missing or malformed attachment envelope', () => {
    assert.equal(attachmentOf({ type: 'image' }), null)
    assert.equal(attachmentOf({ type: 'image', attachment: null }), null)
    assert.equal(attachmentOf({ type: 'image', attachment: 'x' }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: {} }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: { attachmentId: '' } }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: { attachmentId: 42 } }), null)
  })

  test('a verbatim file keeps the name and size the log carries', () => {
    assert.deepEqual(
      attachmentOf({ type: 'file', attachment: { attachmentId: 'sha256:x', name: 'notes.md', bytes: 47320 } }),
      { kind: 'file', attachmentId: 'sha256:x', name: 'notes.md', bytes: 47320 },
    )
    assert.deepEqual(attachmentOf({ kind: 'file', attachment: { attachmentId: 'sha256:x' } }), { kind: 'file', attachmentId: 'sha256:x' })
    assert.deepEqual(
      attachmentOf({ type: 'file', attachment: { attachmentId: 'sha256:x', name: '', bytes: -1 } }),
      { kind: 'file', attachmentId: 'sha256:x' },
    )
  })

  test('an image passes every proven fact and drops the hostile ones', () => {
    assert.deepEqual(
      attachmentOf({
        type: 'image',
        attachment: {
          attachmentId: 'sha256:i',
          mediaType: 'image/jpeg',
          name: 'result-image-1.jpg',
          bytes: 146227,
          width: 1568,
          height: 1350,
          originalDimensions: { width: 3462, height: 1211 },
        },
      }),
      {
        kind: 'image',
        attachmentId: 'sha256:i',
        name: 'result-image-1.jpg',
        mediaType: 'image/jpeg',
        bytes: 146227,
        width: 1568,
        height: 1350,
        originalDimensions: { width: 3462, height: 1211 },
      },
    )
    assert.deepEqual(
      attachmentOf({
        kind: 'image',
        attachment: {
          attachmentId: 'sha256:i',
          mediaType: '',
          name: '',
          bytes: '500',
          width: NaN,
          height: 0,
          originalDimensions: 'big',
        },
      }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: null } }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: { width: 0, height: 10 } } }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: { width: 4000, height: 3000 } } }),
      { kind: 'image', attachmentId: 'sha256:i', originalDimensions: { width: 4000, height: 3000 } },
    )
  })
})

describe('attachmentsIn', () => {
  test('keeps the message order and drops everything else', () => {
    const content = [
      { type: 'file', attachment: { attachmentId: 'f1', name: 'a.svg', bytes: 2627 } },
      { type: 'text', text: 'hello' },
      { type: 'image', attachment: { attachmentId: 'i1', width: 10, height: 10 } },
      null,
      'plain',
      { type: 'file' },
    ]
    assert.deepEqual(attachmentsIn(content), [
      { kind: 'file', attachmentId: 'f1', name: 'a.svg', bytes: 2627 },
      { kind: 'image', attachmentId: 'i1', width: 10, height: 10 },
    ])
  })

  test('a non-array content has none', () => {
    assert.deepEqual(attachmentsIn(undefined), [])
    assert.deepEqual(attachmentsIn('content'), [])
  })
})
