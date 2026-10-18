// The per-file attachment price (src/shared/fileTokens.ts): what a durable file costs in a request,
// which is the harness's model-facing handle and never the file's bytes.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateFileTokens } from '../../src/shared/fileTokens'

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function file(over: { name?: string; bytes?: number; attachmentId?: string } = {}) {
  return { attachmentId: DIGEST, name: 'notes.md', bytes: 120, ...over }
}

describe('estimateFileTokens', () => {
  test('the price is the harness handle priced as one text block', () => {
    // The handle the harness emits when the environment cannot read the stored copy, verbatim.
    const handle = '[File "notes.md" (120 bytes, sha256:01234567) was uploaded, but the current execution'
      + ' environment cannot access a readable path. Report that limitation if its contents are needed;'
      + ' do not claim to have read it.]'
    assert.equal(estimateFileTokens(file()), Math.ceil(handle.length / 4) + 4)
    assert.equal(estimateFileTokens(file()), 57)
  })

  test('a 778 kB file costs one token more than a 120 B one: the bytes are never sent', () => {
    assert.equal(estimateFileTokens(file({ bytes: 778_285 })), 58)
  })

  test('only the digest prefix reaches the handle', () => {
    assert.equal(estimateFileTokens(file({ attachmentId: `sha256:01234567${'0'.repeat(56)}` })), 57)
    assert.equal(estimateFileTokens(file({ attachmentId: `sha256:${'f'.repeat(64)}` })), 57)
  })

  test('the priced arm is the shorter one: the path-bearing arm costs more', () => {
    // The other harness arm appends the copy's read path, which only the live environment resolves.
    const pathArm = ' verbatim read-only copy saved at "/home/u/.dsh/attachments/v1/files/ab/0123456789abcdef'
      + '/notes.md". Read that path with your file tools when its contents are needed; copy it to a'
      + ' writable location before modifying it. When delegating file work, include this saved path in the'
      + ' delegation prompt; only subagents sharing this execution environment can read it.'
    assert.ok(Math.ceil((400 + pathArm.length) / 4) + 4 > (estimateFileTokens(file()) as number))
  })

  test('a name or a byte size the log does not prove prices nothing', () => {
    assert.equal(estimateFileTokens(file({ name: undefined })), null)
    assert.equal(estimateFileTokens(file({ bytes: undefined })), null)
    assert.equal(estimateFileTokens(file({ name: undefined, bytes: undefined })), null)
  })
})