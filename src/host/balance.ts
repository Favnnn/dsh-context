/**
 * The DeepSeek open-platform BALANCE route — the data behind the Context Insights page's header
 * capsule (client/balance.ts).
 *
 * Reaching the platform's one account endpoint (`GET /user/balance`) needs the API key, which by
 * design never rides to the browser, so the HOST reads it and serves the redacted figures: the
 * provider's settings row (read off the Config-form projection, deepseekSectionOf) supplies the
 * credential ref and endpoint override, and the credentials service resolves the key. Any
 * missing fact answers a typed `null`, as does a failed or malformed platform read — the capsule
 * renders nothing rather than a stale figure. Identical reads share one outbound fetch while in
 * flight, and nothing outlives it.
 *
 * The transport is Connection's fetch-route registry through a deferred inject, so load order
 * never matters and a harness without the registry simply never arms the route.
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's balance route, under the authenticated `/api` fence. */
export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The settings id the DeepSeek API-key provider serves its section under, preferred over its entry name. */
const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** The DeepSeek platform's public API root (`GET /user/balance`). */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

const FETCH_TIMEOUT_MS = 10_000

/** The harness `settings` service: the Config-form `describe()` projection is the only face served. */
interface SettingsHostFace {
  describe?(): unknown
}

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

interface DeepSeekFacts { baseUrl: string; apiKey: string }

/** The DeepSeek API-key provider's settings section, folded from the Config-form `describe()`
 * projection: its row declares the top-level `apiKeyEnv` credential ref, the shape only that
 * provider declares. Rows fold in isolation — a hostile row drops whole, valid siblings serve. */
function deepseekSectionOf(ctx: Context): Record<string, unknown> | null {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  if (typeof settings?.describe !== 'function') return null
  try {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return null
    let shaped: Record<string, unknown> | null = null
    for (const row of rows) {
      try {
        const record = asRecord(row)
        if (record === null) continue
        const value = asRecord(record.value)
        if (value === null || typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv === '') continue
        if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === 'llm-deepseek-api-key') return value
        shaped ??= value
      } catch {
        continue
      }
    }
    return shaped
  } catch {
    return null
  }
}

/** Resolve the connection facts the provider itself serves requests with; `null` whenever any fact is missing. */
async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const section = deepseekSectionOf(ctx)
  if (section === null) return null
  const apiKeyEnv = section.apiKeyEnv as string
  const baseUrl = typeof section.baseURL === 'string' && section.baseURL !== ''
    ? section.baseURL
    : PUBLIC_BASE_URL
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  let hit: { value?: unknown } | undefined
  try {
    hit = await resolve(apiKeyEnv)
  } catch {
    return null
  }
  const apiKey = typeof hit?.value === 'string' ? hit.value : ''
  return apiKey === '' ? null : { baseUrl, apiKey }
}

/** Narrow the platform's payload to the wire value: the total is the two re-proved parts summed,
 * so the viewer's arithmetic is the authority. An entry failing the shape drops whole, and a
 * payload with no valid entry is no balance at all. */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // A hostile entry may throw on property access; it drops whole.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === ''
        || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

export function resetBalance(): void {
  inFlight = null
}

/** One platform read for these facts, shared by identical reads already in flight; nothing is
 * remembered, since the balance moves with every billed request. Every failure path — transport,
 * timeout, non-ok status, malformed payload — resolves `null`. */
async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl.replace(/\/+$/, '') + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
      // Any failure serves null — the capsule stays hidden.
    }
    return value
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // The `inFlight !== null` guard makes the settled read's own clear the current value's.
    inFlight = null
  }
}

/** Serve the balance route whenever the connection service composes; the registration rides the
 * injected fiber, so unloading withdraws it. */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (): Promise<Response> => {
      const facts = await resolveFacts(ctx)
      const value = facts !== null ? await readBalance(facts) : null
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BALANCE_ROUTE, handler, 'dsh-context: balance route')
  })
}
