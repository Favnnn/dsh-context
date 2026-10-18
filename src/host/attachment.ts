/**
 * The attachment-preview route (`/api/dsh-context/attachment`) — the previewable host path of one
 * attachment a session's log cites.
 *
 * dsh's own preview column renders a file from a `dsh-resource://file/…` address and dispatches its
 * viewer by the path's SUFFIX, so this route answers with a path that carries the attachment's name:
 *
 * - A verbatim FILE already has one: the attachment store publishes every stored file as a named
 *   alias (`<home>/attachments/v1/files/<xx>/<digest>/<name>`), returned by `attachments.fileHostPath`.
 * - A normalized IMAGE does not — its object is digest-named and suffixless — so the route publishes
 *   (or reuses) a named hard link under the plugin's own preview cache and answers with that. The
 *   link shares the object's immutable, digest-verified bytes; nothing is copied on the common path.
 *
 * No bytes travel: the browser hands the path to the harness, exactly as the File Activity card does.
 *
 * Same transport and posture as the detail and fleet routes (detail.ts): Connection's exact
 * Fetch-route registry behind the authenticated `/api` fence, the durable log read through
 * `ctx.sessionQuery.observeSession` (live-preferred), and the read admitted by the shared cold-read
 * gate. Authorization mirrors the harness's own attachment gateway: a path resolves only while the
 * SESSION'S OWN log cites the attachment, so an id an untrusted replay invented resolves to nothing.
 */

import { copyFile, link, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { attachmentOf, isImageName, leafNameOf } from '../shared/attachment'
import type { AttachmentRef } from '../shared/attachment'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's attachment route, under the authenticated `/api` fence. */
export const ATTACHMENT_ROUTE = '/api/dsh-context/attachment'

/** Normalized image media types → the suffix a viewer dispatches on. */
const IMAGE_MEDIA_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** The host attachment store, as far as the route consumes it. */
interface AttachmentStoreFace {
  fileHostPath?(ref: unknown): string | undefined
  imageHostPath?(ref: unknown): string | undefined
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Depth cap for the payload walk: real citation sites sit at `data.content[…]`,
 * `data.message.content[…]`, and `data.inserted[…].content[…]` (a spliced inbox delivery). */
const WALK_MAX_DEPTH = 8

/** The first attachment block citing `id` anywhere below `value`, or null. Untrusted input: only
 * arrays and objects are walked, the depth is capped, and a hostile object drops that subtree. */
function attachmentIn(value: unknown, id: string, depth: number): AttachmentRef | null {
  if (depth > WALK_MAX_DEPTH) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = attachmentIn(item, id, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const ref = attachmentOf(value)
  if (ref !== null && ref.attachmentId === id) return ref
  for (const child of Object.values(value as Record<string, unknown>)) {
    const hit = attachmentIn(child, id, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/** The session's own citation of one attachment: the first logged block naming it, wherever the
 * event payload carries it — a user message's content, a tool result's blocks, a spliced inbox
 * delivery. An untrusted log: a hostile payload drops out instead of throwing. */
export function referencedAttachmentOf(events: readonly unknown[], attachmentId: string): AttachmentRef | null {
  for (const entry of events) {
    try {
      const hit = attachmentIn(entry, attachmentId, 0)
      if (hit !== null) return hit
    } catch { /* a hostile payload names nothing */ }
  }
  return null
}

/** The name one image previews under. The preview column dispatches its viewer by suffix, so a
 * display name counts only when its suffix is one a viewer claims — the verified media type names
 * the rest (a re-encoded source keeps its original name), and an image whose media type the harness
 * never admits names nothing. */
export function imagePreviewNameOf(ref: AttachmentRef): string | null {
  const leaf = leafNameOf(ref.name ?? '')
  if (leaf !== '' && isImageName(leaf)) return leaf
  const extension = ref.mediaType !== undefined ? IMAGE_MEDIA_EXTENSION[ref.mediaType] : undefined
  return extension === undefined ? null : `attachment.${extension}`
}

/** The plugin's preview cache under the same home the attachment store lives in: the store's object
 * path is `<home>/attachments/v1/objects/<xx>/<digest>`. Null when the path is not that shape (an
 * unfamiliar backend), so the route reports no preview instead of guessing a directory. */
function previewAliasDirOf(objectPath: string): string | null {
  const root = dirname(dirname(dirname(objectPath)))
  if (basename(root) !== 'v1' || basename(dirname(root)) !== 'attachments') return null
  return join(dirname(dirname(root)), 'cache', 'dsh-context', 'previews')
}

/** The verbatim file's own named alias, or null when the store cannot locate it (an absent store, a
 * non-host-file backend, or a reference the store refuses). */
function filePathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): string | null {
  if (typeof store?.fileHostPath !== 'function') return null
  try {
    const path = store.fileHostPath({ attachmentId: ref.attachmentId, name: ref.name ?? '', bytes: ref.bytes ?? 0 })
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    // A malformed reference (bad digest, unsanitized name) is no path, never a throw.
    return null
  }
}

/** Publish (or reuse) the named hard link an image previews through; an existing link is the same
 * immutable object, so it is the answer. A cross-device or otherwise link-less host falls back to a
 * copy, and any failure resolves null rather than throwing out of the route. */
async function imageAliasOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  if (typeof store?.imageHostPath !== 'function') return null
  let objectPath: string | undefined
  try {
    objectPath = store.imageHostPath({
      attachmentId: ref.attachmentId,
      ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
      ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
      ...(ref.width !== undefined ? { width: ref.width } : {}),
      ...(ref.height !== undefined ? { height: ref.height } : {}),
      ...(ref.name !== undefined ? { name: ref.name } : {}),
    })
  } catch {
    return null
  }
  if (typeof objectPath !== 'string' || objectPath === '') return null
  const name = imagePreviewNameOf(ref)
  if (name === null) return null
  const directory = previewAliasDirOf(objectPath)
  if (directory === null) return null
  const alias = join(directory, basename(dirname(objectPath)), basename(objectPath), name)
  try {
    await mkdir(dirname(alias), { recursive: true })
    try {
      await link(objectPath, alias)
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) await copyFile(objectPath, alias)
    }
    return alias
  } catch {
    return null
  }
}

/** The previewable path of one cited attachment: a file's own named alias, or an image's. */
async function previewPathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  return ref.kind === 'file' ? filePathOf(store, ref) : await imageAliasOf(store, ref)
}

/** Serve the attachment route whenever the connection service is composed (the fleet route's own
 * posture); sessionQuery and the attachment store are re-read per request, so a late-arriving
 * service still arms. */
export function watchAttachmentChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let attachmentId: unknown
      try {
        const body = asRecord(await request.json())
        sessionId = body?.sessionId
        attachmentId = body?.attachmentId
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      if (typeof attachmentId !== 'string' || attachmentId === '') {
        return failure('dsh-context/bad-request', 'missing attachmentId')
      }
      try {
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const store = ctx.get('attachments') as AttachmentStoreFace | undefined
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          try {
            const events = (observation as { events?: unknown } | null)?.events
            if (!Array.isArray(events)) return null
            const ref = referencedAttachmentOf(events, attachmentId)
            if (ref === null) return null
            const path = await previewPathOf(store, ref)
            return path === null ? null : { path }
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, ATTACHMENT_ROUTE, handler, 'dsh-context: attachment route')
  })
}
