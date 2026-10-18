/**
 * The projection warm-up: a one-pass background backfill that gives every stored session its
 * `contextActivity` + `contextTimeline` rows, run on demand by its only reader.
 *
 * The session list serves durable cache rows only, so a session folded before a unit existed,
 * or whose rows went version-stale, has no usable row until it next goes live: the heatmap
 * stays empty and the cards keep their no-data note. The cache's cold-read ladder
 * (`sessionProjectionCache.coldSnapshot`) closes that gap — read the stored log once, seed each
 * unit from its cached rows, fold the remainder, write the refreshed checkpoint back.
 *
 * The pass runs when the client POSTs the trigger route on the Context Insights page's first open,
 * not at boot: an at-startup pass would cold-read the whole corpus on every boot whether the page
 * is ever opened or not. It runs once per process and skips live sessions, which fold for
 * themselves.
 *
 * OPTIONAL BY CONTRACT: deferred injects, every face re-proved before use, each session's read
 * isolated — a deployment without the connection route or the cold-path services never arms the
 * pass. A log the harness refuses to migrate is permanent, so its per-session detail drops to
 * debug and the pass ends with one summary info line.
 */

import { asRecord } from './record'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's warm-up trigger route, under the authenticated `/api` fence. */
export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

/** The corpus listing face, as consumed. */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

/** The cache's two cold-path verbs, as consumed (re-proved at runtime). */
interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

/** The sliced fold's extra faces (all re-proved at runtime; any absence keeps the
 * single-shot path). `restore` and `hydrate` ride the registry the plugin already injects;
 * `prepare` and `write` are the same faces session-query's observation handoff uses. */
interface SlicedFoldFaces {
  restore(
    checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number, header: SessionHeader, inheritedEventCount: unknown,
  ): unknown
  hydrate(session: unknown, checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number): unknown
  prepare(id: string, options: { seed: readonly SessionEvent[]; meta: unknown; inheritedEventCount: unknown; eventState: string }): unknown
  write(session: unknown): Promise<unknown>
}

/** One persistence read handle, as consumed. */
interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
}

/** The pacing floor for BOTH granularities (between slices and between sessions): each cold
 * read is a full log decode, and a boot-time host under sustained read pressure stalls its own
 * client handshake. The actual rest is proportional to the work just done (at least this
 * floor), so the pass never exceeds ~50% duty (issue #145). */
const MIN_REST_MS = 25

/** The sliced fold's granularity: at ~13µs/event a slice is a ~25ms synchronous block
 * (measured ≤88ms including the per-slice state re-validation), so even a 30k-event session
 * never lands on the event loop as one uninterruptible second. */
const SLICE_EVENTS = 2_000

/** The pass's sustained-work budget: after this much cumulative fold time the pass takes a
 * full recovery pause (and says so), then resumes where it stopped — a long corpus fills
 * progressively instead of holding the host in one crowded window. */
const ROUND_WORK_BUDGET_MS = 8_000
const ROUND_PAUSE_MS = 2_000

/** The pacing seam, injectable for tests (mirroring the cold-read gate's `reading`). */
export interface BackfillPacing {
  now: () => number
  sleep: (ms: number) => Promise<void>
  minRestMs: number
  workBudgetMs: number
  roundPauseMs: number
}

const DEFAULT_PACING: BackfillPacing = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  minRestMs: MIN_REST_MS,
  workBudgetMs: ROUND_WORK_BUDGET_MS,
  roundPauseMs: ROUND_PAUSE_MS,
}

/** The `name` family dsh raises for a durable log it cannot interpret: the persistence seam
 * translates the format edge's refusal into `SessionFormatUnsupportedError`, so classify by prefix and import no dsh symbol. */
const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

const PROBE_KEYS = ['contextActivity', 'contextTimeline']

function servesRows(cache: ProjectionCacheLike, header: SessionHeader): boolean {
  try {
    // Unseeded sessions carry no inherited prefix (cut 0), and a seeded header's real cut only
    // arrives with the log read below, so the probe misses and the session takes the cold-read
    // path. A version-stale row also reads as absent; a hostile face's throw does the same.
    const block = asRecord(cache.cachedSnapshot(header, PROBE_KEYS))
    const values = asRecord(block?.values)
    return values !== null
      && values.contextActivity !== undefined
      && values.contextTimeline !== undefined
  } catch {
    return false
  }
}

/** Read one stored log through a read handle, mirroring dsh-session-query's readColdSessionLog. */
async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    // A hostile persistence result serves an empty log, never a throw.
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch { /* the read failure is the actionable cause */ }
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}

/** Whether one session is live (folds for itself — a cold write would only
 * race its own checkpoints). A throwing registry read conservatively skips
 * the session too: better to leave a row unfolded than to write over a possibly-live one. */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

/** The sliced fold's per-session outcome: the rows landed, the session went live mid-fold
 * (it folds for itself — skip silently), or the pass was aborted mid-fold (stop quietly).
 * `workMs` is the measured slice work, so the session-level accounting never bills it twice. */
interface SliceOutcome {
  outcome: 'done' | 'live' | 'aborted'
  workMs: number
}

/** One cold fold in event-count slices (issue #145): a monster session's whole-log restore
 * would otherwise land as ONE uninterruptible synchronous block (measured ~1s per 30k events
 * on a fast host) inside a boot-time window already crowded with a hundred other folds.
 * Each slice seeds every unit from the previous slice's rows IN MEMORY (the registry's
 * restore is the cache's own cold-read computation, so the composed result is byte-identical
 * to one single-shot coldSnapshot), the event loop breathes between slices, and exactly ONE
 * durable write-back lands at the end — a crash mid-fold leaves no partial rows, the same
 * failure semantics as the single-shot path. */
async function coldSnapshotSliced(
  ctx: Context,
  faces: SlicedFoldFaces,
  sessions: Record<string, unknown> | null,
  log: { header: SessionHeader; inheritedEventCount: unknown; events: readonly SessionEvent[] },
  signal: AbortSignal,
  rest: (costMs: number) => Promise<void>,
  now: () => number,
): Promise<SliceOutcome> {
  const { header, inheritedEventCount, events } = log
  let rows: unknown = {}
  let workMs = 0
  for (let end = SLICE_EVENTS; ; end += SLICE_EVENTS) {
    const last = end >= events.length
    const started = now()
    const restored = asRecord(faces.restore(rows, last ? events : events.slice(0, end), 0, header, inheritedEventCount))
    rows = restored?.checkpoint ?? {}
    const sliceCost = now() - started
    workMs += sliceCost
    if (last) break
    await rest(sliceCost)
    if (signal.aborted) return { outcome: 'aborted', workMs }
  }
  let prepared: unknown
  try {
    prepared = faces.prepare(header.id, {
      seed: events,
      meta: structuredClone(header),
      inheritedEventCount,
      eventState: 'shared-frozen',
    })
  } catch (error: unknown) {
    // The store rejects an id with a live owner: the session attached mid-fold and now folds for itself.
    if (isLive(sessions, header.id)) return { outcome: 'live', workMs }
    throw error
  }
  // The rows end at the log's last seq, so hydrate installs the cells without refolding.
  faces.hydrate(prepared, rows, events, 0)
  try {
    await faces.write(prepared)
  } catch (error: unknown) {
    // Fail-soft, mirroring the cache's own write-back posture: a lost write costs a refold
    // on the next pass, never a wrong row.
    ctx.logger.warn(`dsh-context: projection backfill write-back for "${header.id}" failed (cache stays stale): ${messageOf(error)}`)
  }
  return { outcome: 'done', workMs }
}

function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

/** Printable form — a hostile error may throw on its own toString. */
function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/** Arm the warm-up behind its trigger route: the route flips `requested` on the page's
 * first open and the cold-path faces compose `launch`; whichever lands second launches the one
 * pass. Returns the deferred injects' disposer (abort on unload). */
export function watchActivityBackfill(
  ctx: Context,
  coldReads: ColdReadGate = makeColdReadGate(),
  pacing: BackfillPacing = DEFAULT_PACING,
): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = ctx.inject(['connection'], (c) => {
    const handler = () => {
      requested = true
      tryLaunch()
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BACKFILL_ROUTE, handler, 'dsh-context: backfill route')
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)

    // The sliced fold's faces: the registry the plugin already injects, plus the sessions and
    // cache write verbs. Any absence keeps every session on the single-shot coldSnapshot path.
    // Bind at extraction: an unbound hand-off loses `this` on the real faces.
    const registry = asRecord((ctx as unknown as Record<string, unknown>).sessionProjections)
    const sliceFaces: SlicedFoldFaces | null = registry !== null
      && typeof registry.restore === 'function'
      && typeof registry.hydrate === 'function'
      && sessions !== null
      && typeof sessions.prepare === 'function'
      && typeof cache.write === 'function'
      ? {
        restore: (registry.restore as SlicedFoldFaces['restore']).bind(registry),
        hydrate: (registry.hydrate as SlicedFoldFaces['hydrate']).bind(registry),
        prepare: (sessions.prepare as SlicedFoldFaces['prepare']).bind(sessions),
        write: (cache.write as SlicedFoldFaces['write']).bind(cache),
      }
      : null

    const abort = new AbortController()
    const run = async (): Promise<void> => {
      const listed = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
      if (!Array.isArray(listed)) return
      let folded = 0
      let refused = 0
      let paused = false
      // One rest serves both granularities (between slices and between sessions): the pause is
      // proportional to the work just done, and a full recovery break follows every workBudgetMs
      // of cumulative fold time — the pass says when it pauses and resumes on its own. The sleep
      // wakes early on abort so dispose never waits out a pause.
      let roundWork = 0
      const sleep = async (ms: number): Promise<void> => {
        if (abort.signal.aborted) return
        // Assigned synchronously by the Promise executor below.
        let onAbort!: () => void
        try {
          await Promise.race([
            pacing.sleep(ms),
            new Promise<void>((resolve) => {
              onAbort = () => { resolve() }
              abort.signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        } finally {
          abort.signal.removeEventListener('abort', onAbort)
        }
      }
      const rest = async (costMs: number): Promise<void> => {
        roundWork += costMs
        if (roundWork >= pacing.workBudgetMs) {
          roundWork = 0
          ctx.logger.info(`dsh-context: projection backfill pausing after ${Math.round(pacing.workBudgetMs / 1000)}s of fold work; resuming in ${Math.round(pacing.roundPauseMs / 1000)}s`)
          await sleep(pacing.roundPauseMs)
          return
        }
        await sleep(Math.max(pacing.minRestMs, costMs))
      }
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        if (servesRows(cache as unknown as ProjectionCacheLike, header)) continue
        const started = pacing.now()
        let slicedWorkMs = 0
        try {
          const admitted = await coldReads.admit(async () => {
            const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
            // The handle's header is authoritative (fixed at open); the listed one was its probe.
            if (sliceFaces !== null && log.events.length > SLICE_EVENTS) {
              const sliced = await coldSnapshotSliced(ctx, sliceFaces, sessions, log, abort.signal, rest, pacing.now)
              slicedWorkMs = sliced.workMs
              return sliced.outcome
            }
            ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
            return 'done' as const
          })
          if (admitted === undefined) {
            // Pressure does not fall within a pacing tick, so re-probing per session only delays the host's own work.
            paused = true
            break
          }
          if (admitted === 'aborted') return
          if (admitted === 'done') folded++
        } catch (error: unknown) {
          if (isUnsupportedFormat(error)) {
            // Permanent and source-side: the per-session detail drops to
            // debug; the summary below is the pass's only above-debug word.
            refused++
            ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          } else {
            ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          }
        }
        // Slice work already rested (and was billed) mid-fold; the session-level rest covers the
        // remainder only — decode, write-back, or the whole single-shot fold.
        await rest(Math.max(0, pacing.now() - started - slicedWorkMs))
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (paused) {
        ctx.logger.info('dsh-context: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)')
      }
      if (refused > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
      })
    }
    tryLaunch()
    return () => { abort.abort() }
  })

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
