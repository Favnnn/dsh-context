import { rangeWindowOf, type OverviewRange, type OverviewRow } from '../../src/client/overview'
import type { SessionCostUsage } from '../../src/shared/types'

/** A preset's resolved scope window at `now` — the page's own resolution, spelled the way the panel spells it. */
export const win = (range: OverviewRange, now: number) => rangeWindowOf(range, now)

export const COST: SessionCostUsage = {
  deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 10, output: 40 } } },
}

export function rowOf(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: 's1',
    title: 'session one',
    updatedAt: 100,
    running: false,
    current: false,
    archived: false,
    timeline: null,
    activity: null,
    family: [over.timeline ?? null],
    familyCost: null,
    ...over,
  }
}
