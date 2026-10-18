/** The skill catalog behind the Insights page's skill card: one POST to the
 * plugin's `/api/dsh-context/skills` route per panel open, anchored on the
 * current session; a failed read renders the tallies unenriched. */

import type { SkillInfo } from '../shared/types'
import { SKILLS_ROUTE } from './apiRoutes'
import { asRecord } from './services'

/** Narrow the route's payload: the name is the join key and must prove itself; path and source ride only when proved. */
export function skillInfoListOf(value: unknown): SkillInfo[] | null {
  const list = asRecord(value)?.skills
  if (!Array.isArray(list)) return null
  const out: SkillInfo[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === null || typeof record.name !== 'string' || record.name === '') continue
    out.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
      ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
    })
  }
  return out
}

/** One route read, narrowed into the card's name-keyed join map. The session id
 * lets the host resolve the workspace AND the preset scope (discovery mounts on
 * agent presets, so a cwd alone lists only global layers). Never rejects; later names win. */
export async function readSkillCatalog(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<ReadonlyMap<string, SkillInfo> | null> {
  try {
    const response = await fetch(SKILLS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    })
    if (!response.ok) return null
    const body = asRecord(await response.json())
    const list = body === null || body.ok !== true ? null : skillInfoListOf(body.value)
    if (list === null || list.length === 0) return null
    return new Map(list.map(info => [info.name, info]))
  } catch {
    return null
  }
}

type TextCopier = (text: string) => Promise<void>

/** The clipboard write through the platform API (absent off a secure context). */
const defaultCopier: TextCopier = async (text) => {
  const clipboard = (globalThis.navigator as { clipboard?: { writeText?: unknown } } | undefined)?.clipboard
  if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable')
  await (clipboard.writeText as (text: string) => Promise<void>).call(clipboard, text)
}

let copier: TextCopier = defaultCopier

export function setSkillCopier(next: TextCopier | null): void {
  copier = next ?? defaultCopier
}

/** Copy the skill's path for the card's footer click, resolving whether the write
 * landed so the "copied" flash never claims a failed write. */
export async function copySkillPath(path: string): Promise<boolean> {
  try {
    await copier(path)
    return true
  } catch {
    return false
  }
}
