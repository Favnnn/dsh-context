/**
 * Per-file token estimate for a durable file attachment — a file's BYTES never reach a model.
 *
 * dsh projects every `file` block to `dsh-llm`'s `fileHandleText` at request assembly and the token
 * meter prices that text in place of the block's structural JSON price, so a file costs its handle
 * whatever its size. The handle names the file, its byte size, and its digest prefix — the facts a
 * log carries. It also names the stored copy's read path, which is execution-world state no log
 * holds (`llm.fileRequestText` resolves it through the live attachment store and fs mapping), so
 * this prices the pathless arm the harness emits when the copy is unreadable.
 */

import { estimateTextTokens } from './estimate'

const DIGEST_PREFIX_LENGTH = 'sha256:'.length
const DIGEST_SHOWN = 8

/** One file's handle price, or null when the log proves neither the name nor the byte size the
 * handle's identity is built from. */
export function estimateFileTokens(ref: { attachmentId: string; name?: string; bytes?: number }): number | null {
  if (ref.name === undefined || ref.bytes === undefined) return null
  const digest = ref.attachmentId.slice(DIGEST_PREFIX_LENGTH, DIGEST_PREFIX_LENGTH + DIGEST_SHOWN)
  const identity = `File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  const handle = `[${identity} was uploaded, but the current execution environment cannot access a`
    + ' readable path. Report that limitation if its contents are needed; do not claim to have read it.]'
  return estimateTextTokens(handle)
}
