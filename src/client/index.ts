/** dsh-context — client half bundle entry. The Context view reads the harness session projection
 * `contextTimeline` (the split generation's slim head); heavy collections arrive on demand from the
 * host's detail endpoint, one read per viewing client (timelineSource.ts). */

import { createElement as h } from 'react'
import { DICT_EN, DICT_RU, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewPanel } from './components/overviewPanel'
import { makePluginConfigCard } from './components/settingsCard'
import { watchInsightPage } from './insightPage'
import { modalStoreOf } from './modalStore'
import { entrySeated, type ClientCtx } from './services'
import { createContextSettings, type ConfigFormsFace, type SettingsField } from './settings'
import { makeContextView } from './components/contextView'
import { makeContextJumpButton } from './components/contextJump'
import { makeFleetView } from './components/fleetView'
import { watchFleetTab } from './fleetTab'
import { makeAgentHeads } from './agentHeads'
import { watchHistoryFaces } from './historyPage'
import { watchPlacement } from './placement'
import { watchSidebarContextTab } from './sidebar'
import { makeViewKit } from './viewkit'

// Import order IS cascade order among same-specificity rules: the Tailwind utilities sheet stays first,
// then base, then the per-component sheets, which keep winning the ties.
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/fleet.css'
import './styles/overview.css'
import './styles/dateRange.css'

const NS = 'dsh-context'

/** The chat→Context jump entry doubles as this bundle's mount marker: no
 * preference gates it, so a ledger seating it means a mount already registered
 * the bundle's seats. */
const JUMP_SLOT = 'conversation.chat.assistant-actions'
const JUMP_ID = 'context-jump'

function apply(ctx: ClientCtx): void {
  // One live mount per page (dsh-context#137). Two mounts of this bundle share
  // one slot ledger, and the client-plugin runner force-assigns a fresh
  // shadowing priority to every registration, so the registry's same-id guard
  // never fires across them and the session header — which renders the raw
  // ledger and matches the active view by id — paints both copies of every
  // seat. A marker already in the ledger means a mount is live: this one adds
  // nothing. Fails open, so a face without the ledger view still mounts.
  if (entrySeated(ctx, JUMP_SLOT, JUMP_ID)) return
  ctx.effect(() => {
    const disposeDictionaries = ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
    // Russian language pack: the catalog entry makes «Русский» selectable (the
    // shell's own Language row lists it too), the single-locale register arms
    // this namespace with the ru dictionary. A face without addLanguage keeps
    // the dictionaries; an occupied entry (another ru pack) degrades the same way.
    let disposeLanguage: (() => void) | undefined
    try {
      disposeLanguage = ctx.locale.addLanguage?.({ id: 'ru', label: 'Русский', fallback: 'en' })
    } catch { /* occupied */ }
    const disposeRu = ctx.locale.register(NS, 'ru', DICT_RU)
    return () => {
      disposeRu()
      disposeLanguage?.()
      disposeDictionaries()
    }
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  // History faces are resolved through the DECLARED inject: a non-declared read of the traced remote proxy
  // throws "cannot get property … without inject" and takes the view down (see historyPage.ts).
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  // One page-scope cold-head cache for every agent-data reader: the Context view's stats cell and inline card
  // (right Sidebar host), and the Fleet tab's card — all of which can be mounted at the same time.
  const heads = makeAgentHeads()
  const ContextView = makeContextView(ctx, kit, settings, heads)
  const FleetView = makeFleetView(ctx, kit, heads)

  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab.context') },
      props => h(ContextView, props),
    )),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-context: placement')

  // The Fleet tab: its own show/hide preference on top of the placement gate (fleetTab.ts).
  ctx.effect(() => watchFleetTab(
    ctx,
    settings,
    props => h(FleetView, props as unknown as Parameters<typeof FleetView>[0]),
    t,
    NS,
  ), 'dsh-context: fleet tab')

  // Chat → Context jump: opens the right Sidebar's tab pinned to the reply's turn where served, else the
  // conversation tab (contextJump.tsx; relay and activation in viewFocus.ts).
  const ContextJump = makeContextJumpButton(ctx, kit)
  ctx.slots.inject(JUMP_SLOT, () => {
    return ctx.slots.register(
      // After the shipped feedback entry (10), still inside the icon row.
      { name: JUMP_SLOT, id: JUMP_ID, order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit, settings)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay',
        id: 'context-modal',
        order: 10,
        locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // Context Insights page: the panel on the keyed `main` slot and its sidebar entry on
  // `sidebar.panellist`, both mounted or unwound by the `insightsEntry` preference (insightPage.ts).
  const OverviewPanel = makeOverviewPanel(ctx, kit)
  ctx.effect(() => watchInsightPage(
    ctx,
    settings,
    // Root-scope seats: the owner props (the standard kit) arrive untyped.
    props => h(OverviewPanel, props as unknown as Parameters<typeof OverviewPanel>[0]),
    t,
    NS,
  ), 'dsh-context: insight page')

  const cardFace = (): {
    hooks: {
      contextSettings: typeof settings.store
      locale: typeof ctx.locale
    }
    set: (field: SettingsField, value: string) => void
    setLocale: (id: string) => void
  } => ({
    hooks: { contextSettings: settings.store, locale: ctx.locale },
    set: (field, value) => { settings.set(field, value) },
    // The runtime setLocale throws on an unregistered id; the row only offers
    // en/ru, and ru's presence in the catalog is the row's own render gate.
    setLocale: (id) => {
      if (id === 'en' || id === 'ru') ctx.locale.setLocale?.(id)
    },
  })

  // Preferences ride the configForms service and the Plugins page's keyed `plugins.bundle.config` slot.
  // The deferred inject fires only where the service exists, so a host without it keeps the schema defaults.
  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(NS)), 'dsh-context: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([NS], () => {
      // slots.inject's disposer is the registration's disposer.
      return c.slots.inject('plugins.bundle.config', () => {
        return c.slots.register(
          { name: 'plugins.bundle.config', key: NS, locale: NS, inject: cardFace },
          props => h(PluginConfigCard, props as unknown as Parameters<typeof PluginConfigCard>[0]),
        )
      }) as () => void
    }), 'dsh-context: plugins-page card')
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}
