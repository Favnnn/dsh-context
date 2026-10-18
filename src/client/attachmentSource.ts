/**
 * The on-click attachment plumbing behind the browser's cards. Nothing is fetched while a message row
 * is merely rendered: one click resolves that attachment's named host path through the plugin's own
 * `/api/dsh-context/attachment` route (host/attachment.ts), and the harness's preview column then
 * opens it — the File Activity card's own two rungs (`previewAddressOf` → `openResourceVia`) with the
 * attachment's real filename carrying the viewer's file kind.
 */

import { previewAddressOf } from './fileActivity'
import type { AttachmentRef } from '../shared/attachment'
import { ATTACHMENT_ROUTE } from './apiRoutes'
import { asRecord, openResourceVia } from './services'
import type { AttachmentLocator, AttachmentOpener, ClientCtx } from './services'

/** Cache ceiling: cards are clicked one at a time, so a small FIFO holds a session's working set. */
const CACHE_MAX = 32

const paths = new Map<string, string>()

/** Drop every cached location (tests; a page never needs it — an id's object is immutable). */
export function clearAttachmentPaths(): void {
  paths.clear()
}

/** One route payload's path, re-proved: a non-string or empty path is no path. */
export function pathOfValue(value: unknown): string | null {
  const data = asRecord(value)
  return data !== null && typeof data.path === 'string' && data.path !== '' ? data.path : null
}

/** The session-authorized attachment locator, or undefined without a session (cards then render
 * metadata only). A failed resolution resolves null and is never cached, so a retry re-reads. */
export function makeAttachmentLocator(sessionId: string | undefined): AttachmentLocator | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return async (attachment: AttachmentRef) => {
    const key = attachment.attachmentId
    const cached = paths.get(key)
    if (cached !== undefined) return cached
    try {
      const response = await fetch(ATTACHMENT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, attachmentId: key }),
      })
      if (!response.ok) return null
      const body = asRecord(await response.json())
      if (body === null || body.ok !== true) return null
      const path = pathOfValue(body.value)
      if (path === null) return null
      if (paths.size >= CACHE_MAX) {
        const oldest = paths.keys().next().value
        /* v8 ignore next 1 -- the cap fires only on a non-empty cache, so the key always exists. */
        if (oldest !== undefined) paths.delete(oldest)
      }
      paths.set(key, path)
      return path
    } catch {
      return null
    }
  }
}

/**
 * Open one attachment in the harness's own preview column, or report that it could not be opened.
 * Resolution order is the File Activity card's: the cited attachment's named host path behind the
 * plugin's route, then the harness's `dsh-resource://file/…` address.
 * @returns whether a preview took the address.
 */
export function makeAttachmentOpener(
  ctx: ClientCtx,
  sessionId: string | undefined,
  workspace: string | undefined,
): AttachmentOpener | undefined {
  const locate = makeAttachmentLocator(sessionId)
  const openPreview = openResourceVia(ctx)
  if (locate === undefined || openPreview === undefined) return undefined
  return async (attachment: AttachmentRef) => {
    const path = await locate(attachment)
    if (path === null) return false
    // The address layer's form only refuses directories; WHICH viewer renders the file is the
    // preview column's own decision, keyed off the path's suffix.
    const address = previewAddressOf(path, 'text', false, sessionId, workspace)
    return address !== undefined && openPreview(address)
  }
}
