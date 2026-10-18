/** The plugin's fetch routes, in their browser-relative spellings — the host halves register the
 * absolute `/api/...` paths under the harness's authenticated fence (host/detail.ts and siblings).
 * Re-declared here because the client bundle inlines every import and must never reach a host module.
 * Relative on purpose (docs/compatibility.md §5.8, issue #159): a root-absolute spelling would drop
 * a reverse proxy's path prefix at the gateway. */

export const DETAIL_ROUTE = 'api/dsh-context/detail'

export const BALANCE_ROUTE = 'api/dsh-context/balance'

export const FLEET_ROUTE = 'api/dsh-context/fleet'

export const SKILLS_ROUTE = 'api/dsh-context/skills'

export const BACKFILL_ROUTE = 'api/dsh-context/backfill'

export const ATTACHMENT_ROUTE = 'api/dsh-context/attachment'
