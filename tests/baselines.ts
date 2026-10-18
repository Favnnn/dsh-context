/**
 * The supported harness compatibility matrix — the ONE source of truth for
 * which dsh baselines this plugin must work on, and how their seams differ.
 *
 * Consumed by:
 *   - tests/host/compat/  (always-on registry-contract drivers, vitest host lane)
 *   - tests/client/compat/ (always-on client-face matrix, vitest jsdom lane)
 *   - tests/compat/ (the `compat` vitest project: the real-code matrix boots
 *     the REAL dsh registry + settings + platform-table sources per baseline
 *     tag and runs the built plugin through them; plus the bundle smoke)
 *
 * Adding a future harness version = adding one entry here (its tag, its
 * cordis, and a face for every seam that differs), then running the matrix.
 * A failing probe names the seam — the connection point to re-fit or
 * refactor — not just "it broke somewhere".
 */

/** The supported dsh tags, in lockstep with the BASELINES entries below. */
export type BaselineId = 'v0.1.7-rc.2' | 'v0.2.0-rc.2'

/** The harness web half's client faces, as far as the compat probes consume them. */
export interface ClientSeam {
  /** The durable-image loader method the browser cards ride. */
  imageFaceMethod: string
  /** MarkdownText's chrome prop the plugin must hand every markdown render. */
  markdownChrome: string
  /** The JsonTree faces the rich-text JSON body rides (src/client/components/richText.tsx): the expander DOM
   * the two-level auto-open toggles, the summary/preview class locals the expanded-row preview rule matches
   * (detailSections.css), the labels contract — plus the shell build's css-module naming those locals surface through. */
  jsonTree: {
    /** All needles live in the primitives JsonTree source. */
    file: string
    needles: readonly string[]
    /** The shell client build's css-module naming pattern source. */
    cssNamingFile: string
    cssNamingNeedle: string
  }
  /** The platform module table the shell seeds (client-bundle requires must resolve). */
  platformModules: readonly string[]
  /** The faces the split timeline's on-demand detail channel rides
   * (host/detail.ts + client/timelineSource.ts): the host's generic
   * Connection RPC registry, the browser caller, and the projection
   * registry's `stateOf` read. Each probe is a needle in the named source file of the baseline tag. */
  detailChannel: {
    /** `HostConnectionRpc` in the connection package's shared rpc source. */
    hostRpcFile: string
    hostRpcNeedle: string
    /** The browser caller's `call(channel, endpoint, payload…)` in the connection client source. */
    clientRpcFile: string
    clientRpcNeedle: string
    /** The registry's `stateOf` unit-state read (the detail endpoint's data source). */
    registryFile: string
    registryNeedle: string
  }
  /** The session-jump seam (the Context Dashboard's session cards and the
   * Agent network card's nodes — issue #90). Every supported line selects a
   * session through the view owner's `uiWorkspace.openSession` (the sidebar
   * row click's own verb), re-spelled `openSession(target: SessionTarget)` by
   * the 0.1.6 selection refactor, which also retired the sessions service's
   * own `open(id)` spelling — absent on every supported line, probed so a
   * resurrection names the seam instead of silently dead-ending the jump. */
  sessionNav: {
    /** The view-owner navigation verb's source, plus this line's signature spelling. */
    workspaceFile: string
    workspaceNeedle: string
    /** The sessions contract source, plus whether this line still declares `open(id: SessionId)`. */
    sessionsFile: string
    sessionsOpen: boolean
  }
  /** The Context Insights page's first-level panel seam: the layout's keyed
   * `main` slot (the page's seat — also the conversation panel's own) and
   * the sidebar's `sidebar.panellist` list (the entry's seat), addressed by
   * one shared id. Both spellings shipped with the sidebar/layout split and
   * are present on every supported line; probed presence-as-declared so a
   * rename names the seam instead of silently orphaning the page. */
  insightPage: {
    /** The panellist contract's declaring source, plus the slot's spelling in it. */
    panellistFile: string
    panellistNeedle: string
    /** The layout's main-slot declaring source, plus the keyed declaration's spelling. */
    mainFile: string
    mainNeedle: string
  }
  /** The slot-ledger read the client's second-mount guard rides
   * (`entrySeated` in src/client/services.ts, dsh-context#137): the
   * `slots` service's raw `entries` view — the same view the session header
   * renders — present on every supported line under the shared projection-
   * registry contract; probed on the SERVICE that carries the call (the
   * renderer's `SlotRegistry`, whose facade can drop it independently of the
   * core's `SlotCore.entries`) so a rename names the seam instead of silently
   * disabling the guard. */
  ledger: {
    /** The registry source declaring the entries view the plugin calls. */
    file: string
    /** The entries view's signature spelling in it. */
    needle: string
  }
  /** The right Sidebar's tab seam — every supported generation ships it. The
   * plugin's registration stays an OPTIONAL deferred inject: a below-baseline
   * host (the gate's fallback composition) may lack the service entirely, and
   * the client must simply never register the tab there instead of pending. */
  sidebar: {
    /** The tab-type registry service's providing source. */
    serviceFile: string
    serviceNeedle: string
    /** The keyed body seat's declaring source. */
    slotFile: string
    slotNeedle: string
    /** The keyed chip-title seat the plugin's tab type also registers into
     * (the emblem-beside-label idiom the shipped files type uses). Present
     * wherever the body seat is; probed separately so a rename names the seam. */
    titleSlotNeedle: string
    /** The navigation face the plugin's file-open affordance rides
     * (`ctx.sidebarRight.openResource`): the controller's providing source and
     * the needle in it. Same package as the registry, so present wherever the
     * tab seam is; probed so a rename names the preview seam instead of silently degrading the affordance. */
    nav: {
      /** The controller source (the public navigation face's implementation). */
      file: string
      needle: string
    }
    /** The guide-entry contract the plugin's contribution must satisfy: one
     * needle per field `SidebarRightGuideEntry` carries on this generation. */
    guideEntry: {
      /** The declaring source. */
      file: string
      fields: readonly string[]
    }
  }
}

export interface Baseline {
  /** The dsh git tag in deepseek-ai/deepseek-harness (local checkout or CI fetch). */
  id: BaselineId
  tag: string
  cordis: string
  /** The @deepseek-ai/dsh-session release that line vendors. The staged
   * session-projection sources import runtime values from it (SessionLogOffset /
   * SessionSeq), so the compat driver must resolve the specifier to the tag's own generation. */
  session: string
  /** The durable-event families THIS line's log carries that the host fold
   * switches on — the probe asserts every one exists in the tag's
   * `KNOWN_SESSION_EVENT_TYPES`. Every supported line is the V4 generation,
   * so the lists match; the matrix also reads the fold's own `case` labels out
   * of `src/host/fold.ts` and asserts each is declared here, so a fold case
   * added without a baseline list fails loudly instead of going unprobed. */
  foldEventTypes: readonly string[]
  client: ClientSeam
  /** The step-boundary identity guard's host seam (src/host/stepIdentity.ts):
   * the agent-loop file that dispatches the `agent/pre-step` waterfall and
   * appends its decision's messages, plus a shipped context plugin proving
   * the `prepend` listener option this guard rides on that line. */
  stepGuard: {
    loopFile: string
    loopNeedles: readonly string[]
    prependProofFile: string
  }
  /** The tag's settings-namespace surface. Every supported line is the V4+
   * Config-form generation: configuration forms derive from each loader
   * entry's own Config schema — the `settings.register` host face is gone
   * (probed absent, so the plugin never calls it), and the browser half rides
   * the `configForms` service and the Plugins page's keyed `plugins.bundle.config` seat. */
  settings: {
    serviceFile: string
    register: boolean
    /** The browser slot the preferences card registers on this generation. */
    cardSlot: string
    cardSlotFiles: readonly string[]
    transport: 'configForms'
    /** The transport's declaring source, plus whether it exists. */
    transportFile: string
    transportPresent: boolean
  }
  /** The balance capsule's host seam (src/host/balance.ts). The facts fold
   * reads the DeepSeek API-key provider's settings row off the Config-form
   * `describe()` projection — the provider row is the entry whose served
   * value declares the top-level `apiKeyEnv` credential ref, preferred under
   * the settings ids the generations have served it as. The retired
   * registered-section `get(ns)` read is probed absent, so a resurrection
   * names the seam instead of silently shadowing the projection. */
  balance: {
    settingsFile: string
    /** The retired `get(ns)` section read — absent on every supported line. */
    settingsGetNeedle: string
    settingsGetPresent: boolean
    /** The Config-form projection needle the fold reads. */
    settingsDescribeNeedle: string | undefined
    /** The provider sources carrying the plugin id and the section shape the fold matches. */
    providerFiles: readonly { file: string; needles: readonly string[] }[]
  }
  /** The system-prompt injection seam (src/host/promptInjection.ts): the
   * prompt-registry service must expose the ordered-section face and the
   * centrally owned order anchors the plugin reads, and the loader must
   * commit volatile-only config edits into the running references, so a
   * preference edit applies from the next model step without remounting. */
  prompt: {
    serviceFile: string
    sectionNeedle: string
    orderAnchors: readonly string[]
    loaderVolatileFile: string
    loaderVolatileNeedle: string
  }
  /** The sliced cold fold's optional faces (src/host/backfill.ts, issue #145):
   * `sessionProjections.restore`/`hydrate`, `sessions.prepare`, and
   * `sessionProjectionCache.write` — any absence keeps the single-shot
   * coldSnapshot path, so the probes pin presence-as-declared: a removal
   * names the seam instead of silently degrading the pass back to whole-log blocks. */
  backfillFold: {
    /** The registry source declaring `restore` and `hydrate`. */
    registryFile: string
    /** The session store source declaring `prepare`. */
    storeFile: string
    /** The projection-cache source declaring `write` and `coldSnapshot`. */
    cacheFile: string
  }
}

/** One support-matrix entry. Every supported line is the V4 generation, so
 * the seams are spelled once here; a future line that diverges on a needle outgrows the factory (inline its entry instead). */
function baseline(id: BaselineId, tag: string, session: string): Baseline {
  return {
    id,
    tag,
    cordis: '4.0.4',
    session,
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'developer/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt',
      'tool/ptc-dispatch',
      'plan/mode', 'compaction/summary', 'compaction/prune', 'system/message',
      'approval/asked', 'approval/decided', 'session/end-seed',
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      jsonTree: {
        file: 'packages/client/ui-primitives/src/JsonTree.tsx',
        needles: ['data-json-expander', 'aria-expanded', 'css.summary', 'css.preview', 'expandTopLevel', 'copyButtonTitle'],
        cssNamingFile: 'packages/client/tsdown.client.ts',
        // git-grep BRE: the brackets must be escaped to match the literal pattern spelling.
        cssNamingNeedle: '\\[hash\\]_\\[local\\]',
      },
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-dockkit',
      ],
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: 'stateOf<',
      },
      sidebar: {
        serviceFile: 'packages/client/ui-sidebar-right/src/client/index.ts',
        serviceNeedle: 'sidebarRightTabs',
        slotFile: 'packages/client/ui-sidebar-right/src/client/contract/slots.ts',
        slotNeedle: 'sidebar.right.pane.tab',
        titleSlotNeedle: 'sidebar.right.pane.tab.title',
        nav: {
          file: 'packages/client/ui-sidebar-right/src/client/service.ts',
          needle: 'openResource(address',
        },
        guideEntry: {
          file: 'packages/client/ui-sidebar-right/src/client/tab-registry.ts',
          fields: [
            'readonly order: number',
            'readonly title: () => string',
            'readonly description?: () => string',
            'readonly icon?: ComponentType<IconProps>',
          ],
        },
      },
      sessionNav: {
        workspaceFile: 'packages/client/ui-workspace/src/client/navigation.ts',
        workspaceNeedle: 'openSession(target: SessionTarget): void',
        sessionsFile: 'packages/api/session-controller/src/client/contract/sessions.ts',
        sessionsOpen: false,
      },
      insightPage: {
        panellistFile: 'packages/client/ui-sidebar/src/client/contract/slots.ts',
        panellistNeedle: "'sidebar.panellist'",
        mainFile: 'packages/client/ui-layout/src/client/index.ts',
        mainNeedle: "'main': { kind: 'keyed'",
      },
      ledger: {
        file: 'packages/client/ui-renderer/src/client/registry.ts',
        // Truncated before the parameter list: the probe greps the tag's
        // sources as basic regexes, where `(` and `[` open groups/classes.
        needle: 'entries(key: keyof SlotMap',
      },
    },
    settings: {
      serviceFile: 'packages/settings/settings/src/index.ts',
      register: false,
      cardSlot: 'plugins.bundle.config',
      cardSlotFiles: ['packages/client/ui-plugin-manager/src/**'],
      transport: 'configForms',
      transportFile: 'packages/client/ui-settings/src/client/config-form.ts',
      transportPresent: true,
    },
    balance: {
      settingsFile: 'packages/settings/settings/src/index.ts',
      settingsGetNeedle: 'get<const Namespace extends string>(ns:',
      settingsGetPresent: false,
      settingsDescribeNeedle: 'describe(options?: SettingsDescribeOptions)',
      providerFiles: [
        {
          file: 'packages/llm/llm-deepseek-api-key/src/index.ts',
          needles: ["export const name = 'llm-deepseek-api-key'"],
        },
        {
          file: 'packages/llm/llm-deepseek-api-key/src/config.ts',
          needles: ["apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile()"],
        },
        {
          file: 'packages/llm/llm-deepseek/src/config.ts',
          needles: ['baseURL: z.string().volatile()'],
        },
      ],
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
    prompt: {
      serviceFile: 'packages/core/system-prompt/src/index.ts',
      sectionNeedle: 'section(section: PromptSection)',
      orderAnchors: ['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_SUFFIX'],
      loaderVolatileFile: 'vendor/loader/src/config/entry.ts',
      loaderVolatileNeedle: 'updateVolatile(ref, source)',
    },
    backfillFold: {
      registryFile: 'packages/session/session-projection/src/index.ts',
      storeFile: 'packages/core/session/src/index.ts',
      cacheFile: 'packages/session/session-projection-cache/src/index.ts',
    },
  }
}

export const BASELINES: readonly Baseline[] = [
  // The oldest supported line — Session format V4: the fold's switched
  // families run the current dialect (`system/message` surface nodes, the
  // embedded assistant streams, `startSeq`/`endSeq` replacements,
  // `tool/ptc-dispatch`), the tool result is a first-class role-`tool`
  // message with lifted `toolCallId`/`isError`, and plugin configuration
  // derives from the entry's own Config schema (the Plugins page's keyed
  // `plugins.bundle.config` seat over the `configForms` transport). The
  // baseline pins `0.1.7-rc.2`, the first release of the line with a
  // complete npm dependency closure; rc.2 adds `startsSeries` to the first
  // `request/header` of a resumed series and the `developer/message`
  // tool-registry events. startsSeries is inert to the fold; registry messages contribute to injected context.
  // 0.1.7 enforces plugin dsh-peer compatibility at startup and install
  // (evaluatePluginCompatibility); this plugin's `>=0.1.7-rc.2` dsh peers
  // satisfy every supported line under the gate's includePrerelease check.
  baseline('v0.1.7-rc.2', 'dsh-v0.1.7-rc.2', '0.1.7-rc.2'),
  // The 0.2.0 line continues the V4 Config-form generation: every seam the
  // plugin rides is spelled exactly as at `0.1.7-rc.2` — the projection
  // registry's register/snapshot/checkpoint/restore contract (drive,
  // stateVersion, wire views), the platform module table, the right
  // Sidebar's tab + chip-title seats and guide-entry contract, the
  // session-jump verb, the detail channel's Connection RPC faces, the
  // Plugins page's keyed `plugins.bundle.config` card slot over the
  // `configForms` transport, the balance settings face, the step-boundary
  // guard, and the durable event vocabulary (still the V4 generation — the
  // session-format tree carries no v4-to-v5 migration). Cordis stays 4.0.4,
  // and the line continues to enforce the plugin dsh-peer gate this plugin's `>=0.1.7-rc.2` peers satisfy.
  baseline('v0.2.0-rc.2', 'dsh-v0.2.0-rc.2', '0.2.0-rc.2'),
]
