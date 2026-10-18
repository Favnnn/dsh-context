/**
 * The Context Insights page's skill card — the activity column's second card,
 * under the heatmap. One row per skill loaded within the page's scope (the
 * range selector's day floor, or the heatmap's pinned day exactly — the
 * aggregation is overview.ts's skillLoadsOf over the rows' family ledgers),
 * in the picked order (the title's segmented toggle: loads / last used): a
 * name-hashed color dot, the load tally, a
 * proportional hairline bar (share of the heaviest row's tally), and the last
 * load's relative time. The sub row under the title carries the scope's
 * totals and a name filter (a case-insensitive substring match narrowing
 * both the rows and the counts). A row click PINs the session list to the
 * sessions that loaded the skill (the column's drill-down, beside the
 * heatmap's day pin — click again to release).
 *
 * The card also answers what a skill IS, in two registers:
 * - a HOVER card (portaled like the page's hoverTip, but structured — the
 *   page's plain-text bubble cannot hold a hierarchy): name + origin chip,
 *   the registry description, the on-disk path, and a footer split between
 *   the load stats and the click action;
 * - the PINNED skill's detail, expanded inline right under its row (a long
 *   list would bury a bottom block): the description first, then a two-column
 *   fact grid (origin / usage / last load / path as a click-to-copy value).
 *   A pin whose row is out of scope falls back to a detached block at the
 *   card's bottom, head row included.
 *
 * The catalog (client/skills.ts, off the plugin's `/api/dsh-context/skills`
 * route) is best-effort end to end — an absent route leaves both registers
 * rendering the tallies unenriched.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { dayKeyOf } from '../../shared/days'
import type { SkillInfo } from '../../shared/types'
import { relativeTime, type SkillLoadStat, type SkillSort } from '../overview'
import { copySkillPath } from '../skills'
import { IconCheck, IconCopy } from '../primitives'
import type { ViewKit } from '../viewkit'

/** The render bound on listed skills — a hostile corpus can coin a name per
 * injection; the overflow line keeps the tally honest without a thousand-row card. */
const MAX_ROWS = 20

/** The description's display bound — a registry description can run paragraphs. */
const MAX_DESC = 160

/** The copied flash's dwell on the path line. */
const COPIED_MS = 1500

/** Anchor-to-bubble distance and the viewport margin the hover card clamps inside, in px. */
const TIP_GAP = 6
const TIP_MARGIN = 8

/** The hover card's identity for the row's `aria-describedby` (one live card at a time). */
const TIP_ID = 'lc-skilltip-bubble'

/** The per-skill dot/bar colors: the composition chart's own palette, picked by name hash so a skill keeps its color across scopes. */
const SKILL_COLORS = [
  'var(--color-blue-500)',
  'var(--color-green-500)',
  'var(--color-purple-500)',
  'var(--color-orange-500)',
  'var(--color-teal-500)',
  'var(--color-pink-500)',
  'var(--color-indigo-500)',
  'var(--color-amber-500)',
] as const

/** The sort toggle's options, in display order; the first is the default. */
const SKILL_SORTS: readonly SkillSort[] = ['loads', 'recent']

/** The skill's stable palette color (djb2 over the name — small, deterministic, sufficient for a distinguishing hint). */
export function skillColorOf(name: string): string {
  let hash = 5381
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0
  return SKILL_COLORS[hash % SKILL_COLORS.length]
}

/** The origin bucket's display label: the registry's known discovery sources
 * localize; an unknown or provider-named source displays raw (it is the
 * registry's data, not UI chrome), and a source-less entry has no label. */
function originLabelOf(t: ViewKit['t'], info: SkillInfo): string {
  const source = info.source
  if (source === 'project-dsh' || source === 'project-agents') return t('ov.skills.src.project')
  if (source === 'user-dsh' || source === 'user-agents') return t('ov.skills.src.user')
  if (source === 'bundled') return t('ov.skills.src.bundled')
  return source ?? ''
}

/** The description's display form: whitespace flattened, capped, ellipsized; '' when there is nothing to show. */
function descriptionOf(info: SkillInfo): string {
  const flat = info.description.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DESC ? flat.slice(0, MAX_DESC) + '…' : flat
}

/** The usage pair's one-line form (loads · sessions), shared by the hover card's footer and the detail grid. */
function usageLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${kit.t('ov.skills.loads', { n: kit.fmt(s.loads) })} · ${kit.t('ov.skills.sessions', { n: kit.fmt(s.sessions) })}`
}

/** The last load's exact stamp (day + clock), resilient to a hostile instant. */
function lastLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${dayKeyOf(s.last) ?? ''} ${kit.fmtTime(s.last)}`.trim()
}

/** The load stats' one-line form for the hover card's footer. */
function statsLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${usageLineOf(kit, s)} · ${lastLineOf(kit, s)}`
}

/** The shared head of both registers: the color dot, the name, and the origin chip when the catalog knows one. */
function DetailHead(props: { name: string; origin: string }): ReactElement {
  return (
    <div className="lc-skilld-head">
      <i className="lc-ov-skill-dot" style={{ background: skillColorOf(props.name) }} />
      <span className="lc-skilld-name">{props.name}</span>
      {props.origin !== '' && <span className="lc-skilld-chip">{props.origin}</span>}
    </div>
  )
}

/** The hovered row's anchor geometry (a plain record so state identity means anchor identity). */
interface HoverRow {
  name: string
  rect: { left: number; top: number; width: number; bottom: number }
}

export interface OverviewSkillsProps {
  /** The scoped aggregation (skillLoadsOf), already sorted. */
  stats: SkillLoadStat[]
  /** The heatmap's pinned day, when the column is filtered to one — the title names it. */
  day?: string | null
  /** The skill the session list is pinned to, when one is. */
  selected?: string | null
  /** Row-pin relay: the clicked skill, or null to release the active pin. */
  onSelect?: (name: string | null) => void
  /** The picked row ordering; omission reads as 'default'. */
  sort?: SkillSort
  /** Sort-toggle relay. */
  onSort?: (sort: SkillSort) => void
  /** The panel's catalog read, joined by name; null while unread or unserved. */
  catalog?: ReadonlyMap<string, SkillInfo> | null
  /** The render instant behind the rows' relative times. */
  now: number
}

export function makeOverviewSkills(kit: ViewKit): (props: OverviewSkillsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewSkills(props: OverviewSkillsProps): ReactElement {
    const { stats } = props
    // The bar's denominator is the heaviest row's tally across the whole
    // scope, wherever the sort put it — keying on the first row overflows
    // the card the moment another ordering (sessions / recent) leads with a
    // lighter row, and keeping the scope's denominator stops the bars from jumping while a name filter narrows the rows.
    const max = stats.reduce((top, s) => Math.max(top, s.loads), 0)

    // ---- the name filter ---------------------------------------------------
    // A local, case-insensitive substring filter over the skill names; the
    // summary counts and the rendered rows follow it, so the card always
    // says what it shows. The input stays mounted on an empty match so the filter can always be cleared from the UI.
    const [query, setQuery] = useState('')
    const needle = query.trim().toLowerCase()
    const visible = needle === '' ? stats : stats.filter(s => s.name.toLowerCase().includes(needle))
    const visibleTotal = visible.reduce((sum, s) => sum + s.loads, 0)

    // ---- the hover card ---------------------------------------------------
    const [hoverRow, setHoverRow] = useState<HoverRow | null>(null)
    const [spot, setSpot] = useState<{ forRow: HoverRow; left: number; top: number } | null>(null)
    const bubbleRef = useRef<HTMLDivElement | null>(null)
    const hoverStat = hoverRow === null ? undefined : stats.find(s => s.name === hoverRow.name)

    // Any scroll or resize moves every anchor — retract rather than float detached (the page's hoverTip zone's own rule).
    useEffect(() => {
      if (hoverRow === null) return undefined
      const retract = (): void => { setHoverRow(null) }
      window.addEventListener('resize', retract)
      window.addEventListener('scroll', retract, true)
      return () => {
        window.removeEventListener('resize', retract)
        window.removeEventListener('scroll', retract, true)
      }
    }, [hoverRow])

    // Measured once per shown card (keyed on the hover record, so a same-row re-render never re-hides).
    useLayoutEffect(() => {
      if (hoverRow === null) return
      const el = bubbleRef.current
      /* v8 ignore next -- unreachable: the portal commits its ref before layout effects run. */
      if (el === null) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const { rect } = hoverRow
      const left = Math.max(TIP_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - TIP_MARGIN))
      const top = rect.top - h - TIP_GAP < TIP_MARGIN ? rect.bottom + TIP_GAP : rect.top - h - TIP_GAP
      setSpot({ forRow: hoverRow, left, top })
    }, [hoverRow])

    // ---- the pinned skill's copy flash ------------------------------------
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // A pin change (or a release) drops any lingering flash; the pending timer clears on unmount.
    useEffect(() => { setCopied(false) }, [props.selected])
    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
    const copyPath = async (path: string): Promise<void> => {
      if (await copySkillPath(path)) {
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => { setCopied(false) }, COPIED_MS)
      }
    }

    // ---- the pinned skill's detail ----------------------------------------
    // Expanded inline right under its row — a long list would bury a bottom
    // block. The description leads (it answers what the skill IS); the facts
    // follow as a two-column label grid — origin, usage, last load, and the
    // full path as a click-to-copy value — so nothing floats unlabeled. A pin
    // whose row is not rendered — out of the filtered scope or past the
    // render bound — falls back to a detached block at the card's bottom,
    // head row included; a catalog-less pin with in-scope tallies still shows its usage rows.
    const selected = props.selected
    const pinnedStat = selected === null || selected === undefined
      ? undefined
      : stats.find(s => s.name === selected)
    const pinnedInfo = selected === null || selected === undefined
      ? undefined
      : props.catalog?.get(selected)
    const detail = selected === null || selected === undefined || (pinnedInfo === undefined && pinnedStat === undefined)
      ? null
      : {
        name: selected,
        origin: pinnedInfo === undefined ? '' : originLabelOf(t, pinnedInfo),
        description: pinnedInfo === undefined ? '' : descriptionOf(pinnedInfo),
        path: pinnedInfo?.path,
      }
    // The copy value's path, narrowed once (a const's narrowing holds in the closure).
    const detailPath = detail?.path
    // Whether the pinned skill's own row renders (in the filtered scope and
    // inside the render bound) — the inline seat exists only then; a pin the
    // filter hides falls back to the detached block at the card's bottom.
    const pinnedRowVisible = selected !== null && selected !== undefined
      && visible.slice(0, MAX_ROWS).some(s => s.name === selected)
    const detailBlock = detail === null ? null : (
      <div className="lc-ov-skill-detail">
        {!pinnedRowVisible && <DetailHead name={detail.name} origin="" />}
        {detail.description !== '' && <p className="lc-skilld-desc">{detail.description}</p>}
        <div className="lc-skilld-grid">
          {detail.origin !== '' && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.source')}</span>
              <span className="lc-skilld-v">{detail.origin}</span>
            </Fragment>
          )}
          {pinnedStat !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.usage')}</span>
              <span className="lc-skilld-v">{usageLineOf(kit, pinnedStat)}</span>
              <span className="lc-skilld-k">{t('ov.skills.k.last')}</span>
              <span className="lc-skilld-v">{lastLineOf(kit, pinnedStat)}</span>
            </Fragment>
          )}
          {detailPath !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.path')}</span>
              <button
                type="button"
                className="lc-skilld-v lc-skilld-pathv"
                data-lc-tip={t('ov.skills.copyPath')}
                onClick={() => { void copyPath(detailPath) }}
              >
                <span className="lc-skilld-pathv-text">{copied ? t('ov.skills.copied') : detailPath}</span>
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              </button>
            </Fragment>
          )}
        </div>
      </div>
    )

    const hoverTip = hoverStat === undefined ? null : (() => {
      const info = props.catalog?.get(hoverStat.name)
      const origin = info === undefined ? '' : originLabelOf(t, info)
      const description = info === undefined ? '' : descriptionOf(info)
      const pinned = props.selected === hoverStat.name
      const shown = spot !== null && spot.forRow === hoverRow ? spot : null
      return createPortal(
        <div
          ref={bubbleRef}
          id={TIP_ID}
          role="tooltip"
          className="lc-tip lc-skilltip"
          style={shown === null
            ? { left: 0, top: 0, visibility: 'hidden' }
            : { left: shown.left, top: shown.top, opacity: 1 }}
        >
          <DetailHead name={hoverStat.name} origin={origin} />
          {description !== '' && <p className="lc-skilld-desc">{description}</p>}
          {info?.path !== undefined && <div className="lc-skilld-path">{info.path}</div>}
          <div className="lc-skilld-foot">
            <span>{statsLineOf(kit, hoverStat)}</span>
            <span className="lc-skilld-hint">{pinned ? t('ov.skills.clickRelease') : t('ov.skills.clickFilter')}</span>
          </div>
        </div>,
        document.body,
      )
    })()

    const sort = props.sort ?? 'loads'
    return (
      <div className="lc-card lc-ov-skills-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.skills')}</span>
          {props.day !== null && props.day !== undefined && <span className="lc-card-sub">{props.day}</span>}
          {/* The sort toggle pins the title row's right corner (the gran's own
              auto margin); a lone row leaves nothing to order. */}
          {stats.length > 1 && (
            <div className="lc-gran" role="group" aria-label={t('ov.skills.sortLabel')}>
              {SKILL_SORTS.map(so => (
                <button
                  key={so}
                  type="button"
                  className={'lc-gran-btn' + (sort === so ? ' lc-gran-on' : '')}
                  aria-pressed={sort === so}
                  onClick={() => { props.onSort?.(so) }}
                >{t('ov.skills.sort.' + so)}</button>
              ))}
            </div>
          )}
        </div>
        {/* The scope's totals live under the title, clear of the toggle; the
            name filter rides the same row, folded right and wrapping below
            under width pressure. A lone row leaves nothing to filter. */}
        {stats.length > 0 && (
          <div className="lc-ov-skills-sub">
            <span className="lc-card-sub lc-ov-skills-sub-n">
              {t('ov.skills.summary', { skills: fmt(visible.length), loads: fmt(visibleTotal) })}
            </span>
            {stats.length > 1 && (
              <input
                className="lc-ov-search lc-ov-skills-search"
                type="search"
                value={query}
                placeholder={t('ov.skills.search')}
                aria-label={t('ov.skills.search')}
                onChange={(ev) => { setQuery(ev.target.value) }}
              />
            )}
          </div>
        )}
        {stats.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.empty')}</div>
        ) : visible.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.noMatch')}</div>
        ) : (
          <div className="lc-ov-skills" role="group" aria-label={t('stats.skills')}>
            {visible.slice(0, MAX_ROWS).map((s) => {
              const color = skillColorOf(s.name)
              const pinned = props.selected === s.name
              // The bar's percentage resolves against the row's padding box
              // but its track is the content box — subtract the horizontal
              // insets (6px + 6px) or 100% would poke through the unit's ring.
              const share = Math.round(s.loads / Math.max(max, 1) * 100)
              const bar = <i className="lc-ov-skill-bar" style={{ width: `calc(${share}% - ${Math.round(share * 12) / 100}px)`, background: color }} />
              const rowButton = (
                <button
                  type="button"
                  className="lc-ov-skill"
                  aria-pressed={pinned}
                  aria-describedby={hoverRow?.name === s.name ? TIP_ID : undefined}
                  onMouseEnter={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    setHoverRow({ name: s.name, rect: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } })
                  }}
                  onMouseLeave={() => { setHoverRow(null) }}
                  onFocus={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    setHoverRow({ name: s.name, rect: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } })
                  }}
                  onBlur={() => { setHoverRow(null) }}
                  onClick={() => { props.onSelect?.(pinned ? null : s.name) }}
                >
                  <i className="lc-ov-skill-dot" style={{ background: color }} />
                  <span className="lc-ov-skill-name">{s.name}</span>
                  <span className="lc-ov-skill-count">×{fmt(s.loads)}</span>
                  <span className="lc-ov-skill-last">{relativeTime(t, s.last, props.now)}</span>
                  {bar}
                </button>
              )
              // The pinned row and its detail read as one unit — a shared
              // fill and a single ring around the pair (`.lc-ov-skill-unit`), never two stacked boxes with a seam.
              return pinned
                ? <div key={s.name} className="lc-ov-skill-unit">{rowButton}{detailBlock}</div>
                : <Fragment key={s.name}>{rowButton}</Fragment>
            })}
            {visible.length > MAX_ROWS && (
              <div className="lc-ov-skill-more">{t('ov.skills.more', { n: visible.length - MAX_ROWS })}</div>
            )}
          </div>
        )}
        {/* The detached seat: the pinned skill's row is out of the visible
            scope (or past the render bound) — the pin still gets its detail. */}
        {!pinnedRowVisible && detailBlock}
        {hoverTip}
      </div>
    )
  }
}
