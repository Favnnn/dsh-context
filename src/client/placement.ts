/** Placement gating for this plugin's conversation views: the per-user `defaultPlacement` preference picks
 *  which registrations carry them — the Context and Fleet tabs, the right Sidebar panel, or both. */

import type { ContextSettings } from './settings'
import type { DefaultPlacement } from '../shared/types'

export interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

/** Whether the preference serves this plugin's conversation-view tabs at all ('sidebar' serves none) — the
 *  rule the Fleet tab's own switch layers on top of (fleetTab.ts). */
export function wantsConversationTabs(settings: ContextSettings): boolean {
  return settings.defaultPlacement() !== 'sidebar'
}

export function watchPlacement(settings: ContextSettings, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  // A mount is tracked by its OWN state, not by the disposer it hands back: a
  // face registering without one (a stripped or foreign `slots`) must still
  // count as mounted, or every later preference publish would register a second
  // copy of the same seats (#137).
  let tabMounted = false
  let sidebarMounted = false
  const mount = (placement: DefaultPlacement): void => {
    const wantTab = wantsConversationTabs(settings)
    const wantSidebar = placement !== 'tab'
    if (wantTab && !tabMounted) {
      const result: unknown = mounts.tab()
      tab = typeof result === 'function' ? result as () => void : undefined
      tabMounted = true
    }
    if (!wantTab && tabMounted) {
      tab?.()
      tab = undefined
      tabMounted = false
    }
    if (wantSidebar && !sidebarMounted) {
      const result: unknown = mounts.sidebar()
      sidebar = typeof result === 'function' ? result as () => void : undefined
      sidebarMounted = true
    }
    if (!wantSidebar && sidebarMounted) {
      sidebar?.()
      sidebar = undefined
      sidebarMounted = false
    }
  }
  mount(settings.defaultPlacement())
  const unsubscribe = settings.store.subscribe(() => { mount(settings.defaultPlacement()) })
  return () => {
    unsubscribe()
    tab?.()
    sidebar?.()
    tab = undefined
    sidebar = undefined
    tabMounted = false
    sidebarMounted = false
  }
}
