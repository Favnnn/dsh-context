/** The DeepSeek open-platform balance pill in the Insights page heading. It paints the figure the previous open
 * remembered while client/balance.ts revalidates in the background, and renders NOTHING when nothing is remembered and
 * the route answers nothing. The breakdown rides the page's portaled hover tip off the pill's `data-lc-tip` (immediate,
 * where a native `title` lags) in the entry's own currency; the pill carries the total. */

import { useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import type { PlatformBalance } from '../../shared/types'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

/** The symbol prefix for the currencies the platform serves; others show their code. */
function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

/** The platform console page behind the capsule's click. */
const USAGE_URL = 'https://platform.deepseek.com/usage'

export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  return function BalanceCapsule(): ReactElement | null {
    const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) =>{  setBalance(v) }))
    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    const entry = balanceEntryOf(balance, active === 'zh' ? 'cny' : 'usd')
    if (entry === null) return null
    const money = (amount: number): string => symbolOf(entry.currency) + amount.toFixed(2)
    // The tooltip lists only the non-zero breakdown parts, so an all-zero account rides bare.
    const tipLines = [
      ...(entry.toppedUp > 0 ? [t('balance.tip.toppedUp') + ': ' + money(entry.toppedUp)] : []),
      ...(entry.granted > 0 ? [t('balance.tip.granted') + ': ' + money(entry.granted)] : []),
    ]
    return (
      <a
        className="lc-ov-balance"
        aria-label={tipLines.length > 0 ? tipLines.join('\n') : undefined}
        {...(tipLines.length > 0 ? { 'data-lc-tip': tipLines.join('\n'), 'data-lc-tip-side': 'bottom' } : {})}
        href={USAGE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <span className="lc-ov-balance-label">{t('balance.title')}</span>
        <span className="lc-ov-balance-value">{money(entry.total)}</span>
      </a>
    )
  }
}
