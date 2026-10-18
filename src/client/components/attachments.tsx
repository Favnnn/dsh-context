/**
 * The Context browser's attachment block. Every `image`/`file` block a message carries renders here
 * in the message's OWN order — one card each, images with their session-authorized thumbnail, other
 * files with their type glyph, type badge, and size. One click IS the preview: the card hands the
 * attachment's named host path to dsh's own preview column (attachmentSource.ts), which renders
 * markdown, code, PDFs, office documents, and images under the file's real name. A refused open
 * leaves a note on that card alone.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { attachmentExtension } from '../../shared/attachment'
import type { AttachmentRef } from '../../shared/attachment'
import { estimateFileTokens } from '../../shared/fileTokens'
import { estimateImageTokens } from '../../shared/imageTokens'
import { fmtBytes } from '../format'
import type { AttachmentOpener, ImageLoader, ImageRefLike } from '../services'
import type { ViewKit } from '../viewkit'
import { FileTypeGlyph } from '../primitives'
import { Section } from './section'

/** One message's ordered attachment block, plus that message's own IO seats. */
export interface AttachmentKit {
  Section: (props: {
    attachments: readonly AttachmentRef[]
    load?: ImageLoader
    open?: AttachmentOpener
  }) => ReactElement
  load?: ImageLoader
  open?: AttachmentOpener
}

/** The image reference the harness loader consumes; only proven facts are handed over. */
function imageRefOf(ref: AttachmentRef): ImageRefLike {
  return {
    attachmentId: ref.attachmentId,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
    ...(ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.height !== undefined ? { height: ref.height } : {}),
    ...(ref.originalDimensions !== undefined ? { originalDimensions: ref.originalDimensions } : {}),
  }
}

/** The name a card shows: the attachment's own, else its kind's label. */
function nameOf(ref: AttachmentRef, t: ViewKit['t']): string {
  return ref.name ?? t(ref.kind === 'image' ? 'attach.image' : 'attach.file')
}

/** One labelled figure of a card. */
interface Fact {
  label: string
  value: string
  tip?: string
}

/** The type line of an attachment (the harness file card's own rule): the upper-cased extension,
 * else the attachment's kind. */
function typeOf(ref: AttachmentRef, t: ViewKit['t']): string {
  const ext = attachmentExtension(ref.name ?? '')
  if (ext !== '') return ext.toUpperCase().slice(0, 8)
  return ref.kind === 'image' ? t('attach.image') : t('attach.file')
}

/** The image thumbnail's lifecycle: bytes through the harness's session-authorized loader, read
 * once per mount. */
function useImageSrc(attachment: AttachmentRef, load: ImageLoader | undefined): {
  src: string | null
  failed: boolean
} {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false })
  // The reference is re-proven from the log on every render, so the read keys off the id and reads
  // the current reference through a latest-ref: a row re-render must not re-read the bytes.
  const latest = useRef(attachment)
  latest.current = attachment
  const id = attachment.attachmentId
  useEffect(() => {
    if (load === undefined) {
      setState({ src: null, failed: false })
      return undefined
    }
    let live = true
    setState({ src: null, failed: false })
    void load(imageRefOf(latest.current)).then(
      (url) => { if (live) setState({ src: url, failed: false }) },
      () => { if (live) setState({ src: null, failed: true }) },
    )
    return () => { live = false }
  }, [id, load])
  return state
}

/** An attachment's facts as label/value rows: an image's dimensions and its vision price, a file's
 * size and what its handle costs — the same figures the chat and the harness's own file card show. */
function factsOf(ref: AttachmentRef, t: ViewKit['t'], fmt: ViewKit['fmt']): Fact[] {
  const dimsOf = (w: number | undefined, h: number | undefined): string | null =>
    w !== undefined && h !== undefined ? `${w}×${h}` : null
  if (ref.kind !== 'image') {
    const rows: Fact[] = []
    if (ref.bytes !== undefined) rows.push({ label: t('attach.size'), value: fmtBytes(ref.bytes) })
    const tokens = estimateFileTokens(ref)
    if (tokens !== null) {
      rows.push({ label: t('attach.token'), value: `≈${fmt(tokens)}`, tip: t('attach.fileTokensTip') })
    }
    return rows
  }
  const rows: Fact[] = []
  // No byte size is stored for the raw raster — dims only.
  const rawDims = ref.originalDimensions !== undefined
    ? dimsOf(ref.originalDimensions.width, ref.originalDimensions.height)
    : null
  if (rawDims !== null) rows.push({ label: t('attach.raw'), value: rawDims })
  const sent = dimsOf(ref.width, ref.height)
  if (sent !== null) {
    rows.push({
      label: t('attach.sent'),
      value: ref.bytes !== undefined ? `${sent} · ${fmtBytes(ref.bytes)}` : sent,
    })
  }
  const tokens = ref.width !== undefined && ref.height !== undefined
    ? estimateImageTokens(ref.width, ref.height)
    : null
  if (tokens !== null) {
    rows.push({ label: t('attach.token'), value: `≈${fmt(tokens)}`, tip: t('attach.imageTokensTip') })
  }
  return rows
}

function AttachmentCard(props: {
  attachment: AttachmentRef
  load?: ImageLoader
  /** This card's own open state: resolving the preview path, or refused. */
  state: 'idle' | 'opening' | 'failed'
  onOpen: () => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}): ReactElement {
  const { attachment, load, state, t, fmt } = props
  const name = nameOf(attachment, t)
  const image = attachment.kind === 'image'
  const thumb = useImageSrc(attachment, image ? load : undefined)
  const hint = t('attach.hint')
  return (
    <button
      type="button"
      className={'lc-att-item hover:border-(--dsw-alias-label-dimmed) hover:bg-[var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))]'
        + (state === 'failed' ? ' lc-att-item-failed' : '')}
      title={name + ' · ' + hint}
      data-state={state}
      aria-busy={state === 'opening'}
      onClick={props.onOpen}
    >
      <span className={'lc-att-thumb' + (image ? '' : ' lc-att-thumb-file')}>
        {image
          ? thumb.src !== null
            ? <img src={thumb.src} alt={name} />
            : (
              <span className={thumb.failed ? 'lc-att-err' : 'lc-att-ph'}>
                {thumb.failed ? '⚠' : load === undefined ? '🖼' : t('attach.loading')}
              </span>
            )
          : (
            <>
              <FileTypeGlyph path={name} size={28} />
              <span className="lc-att-ext">{typeOf(attachment, t)}</span>
            </>
          )}
        {/* The invite rides the thumbnail as a chip over a soft scrim: the facts beside it never move,
            and the glyph or thumbnail stays readable through it. */}
        <span className={'lc-att-hint' + (state === 'opening' ? ' lc-att-hint-on' : '')}>
          <span className="lc-att-hint-label">{state === 'opening' ? t('attach.loading') : hint}</span>
        </span>
      </span>
      <span className="lc-att-meta">
        <span className="lc-att-name" title={name}>{name}</span>
        {/* An image has no extension badge on its tile, so its type keeps the row; a file's badge says it. */}
        {image ? (
          <span className="lc-att-row"><b className="lc-att-row-label">{t('attach.type')}</b>{typeOf(attachment, t)}</span>
        ) : null}
        {factsOf(attachment, t, fmt).map(r => (
          <span key={r.label} className="lc-att-row" title={r.tip}>
            <b className="lc-att-row-label">{r.label}</b>{r.value}
          </span>
        ))}
        {state === 'failed' ? <span className="lc-att-fail">{t('attach.unavailable')}</span> : null}
      </span>
    </button>
  )
}

/** The ordered attachment block. `load`/`open` are optional: without them the cards stay metadata
 * only (a harness with no image face, a deployment with no preview column). */
export function makeAttachmentSection(kit: ViewKit): AttachmentKit['Section'] {
  const { t, fmt } = kit
  return function AttachmentSection(props: {
    attachments: readonly AttachmentRef[]
    load?: ImageLoader
    open?: AttachmentOpener
  }): ReactElement {
    const { attachments, load, open } = props
    const [pending, setPending] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    // A content swap (another message's block) drops every stale state rather than acting on a stranger.
    const key = useMemo(() => attachments.map(a => a.attachmentId).join('\u0000'), [attachments])
    useEffect(() => {
      setPending(null)
      setFailed(null)
    }, [key])
    const activate = useCallback((ref: AttachmentRef) => {
      if (open === undefined) {
        setFailed(ref.attachmentId)
        return
      }
      setPending(ref.attachmentId)
      setFailed(null)
      void open(ref).then((taken) => {
        setPending(cur => (cur === ref.attachmentId ? null : cur))
        setFailed(taken ? null : ref.attachmentId)
      })
    }, [open])
    if (attachments.length === 0) return <></>
    return (
      <Section label={t('attach.title')} count={attachments.length}>
        <div className="lc-att-grid">
          {attachments.map((a, i) => (
            <AttachmentCard
              key={a.attachmentId + ':' + String(i)}
              attachment={a}
              load={load}
              t={t}
              fmt={fmt}
              state={pending === a.attachmentId ? 'opening' : failed === a.attachmentId ? 'failed' : 'idle'}
              onOpen={() => { activate(a) }}
            />
          ))}
        </div>
      </Section>
    )
  }
}
