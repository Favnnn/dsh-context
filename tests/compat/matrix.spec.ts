// The always-on host/client lanes pin the plugin against MIRRORED seam semantics; this project runs the plugin
// against the harness's ACTUAL sources at each baseline tag. A failing probe names the SEAM — the connection point
// to re-fit or refactor — not just "it broke somewhere".
// Preconditions (skipped cleanly when absent; both workflows fetch the baseline tags before `pnpm test`,
// so it always runs there, and a skip under CI fails the run):
//   - a dsh checkout with the baseline tags (env DSH_REPO, default ~/dev/deepseek-harness),
//   - the built plugin (`pnpm run build` first — the matrix exercises the BUILT artifacts, lib/index.js + lib/client.js).

import assert from 'node:assert/strict'
import { beforeAll, describe, test } from 'vitest'
import { BASELINES } from '../baselines'
import * as staging from './staging'

const reasons = staging.skipReasons()
if (reasons.length > 0) {
  // Skipping is right on a dev box with no checkout, but on CI it means the whole compatibility
  // proof is missing behind a green run — the workflows fetch the tags and build first, so a
  // skip there is a broken gate, not an absent prerequisite.
  if (process.env.CI) throw new Error(`[compat] matrix cannot run: ${reasons.join('; ')}`)
  console.warn(`[compat] matrix skipped — ${reasons.join('; ')}`)
}

// The always-runnable part (no checkout needed): every specifier the built bundle requires at runtime must be seeded by EACH baseline's
// platform module table — a require the shell cannot answer is a guaranteed boot crash on that generation.
describe('compat matrix — the per-baseline fold vocabularies', () => {
  test('every event family the fold switches on is declared by every baseline', () => {
    const folded = staging.foldEventTypesFromSource()
    for (const baseline of BASELINES) {
      assert.deepEqual(
        folded.filter(type => !baseline.foldEventTypes.includes(type)),
        [],
        `${baseline.id} would fold an event family no baseline probes`,
      )
    }
  })
})

describe.skipIf(staging.artifactsMissing())('compat matrix — bundle requires vs baseline module tables', () => {
  test.each(BASELINES)('$id: the platform module table answers every bundle require', (baseline) => {
    assert.deepEqual(
      staging.bundleRequires().filter(spec => !baseline.client.platformModules.includes(spec)),
      [],
    )
  })
})

describe.skipIf(reasons.length > 0)('compat matrix — real dsh sources per baseline', () => {
  describe.each(BASELINES)('$id (tag $tag, cordis $cordis)', (baseline) => {
    let report: staging.DriverReport
    // 60s: the driver's own spawn budget. A cold stage dir (fresh clone,
    // cache miss, dependency re-pin) runs a real npm install inside the hook, which the 10s default ceiling cannot cover.
    beforeAll(() => {
      report = staging.runDriver(baseline)
    }, 60_000)

    test('host: the plugin applies into the tag\'s real registry', () => {
      assert.equal(report.registered, true)
    })

    test('host: all three projection values served through the wire', () => {
      assert.deepEqual(report.keys, ['contextActivity', 'contextHeaders', 'contextTimeline'])
    })

    test('host: checkpoint rows pass the tag\'s lossless-JSON cache-write gate', () => {
      assert.equal(report.gateOk, true)
    })

    test('host: cold restore refolds to the live snapshot', () => {
      assert.equal(report.coldMatches, true)
    })

    if (baseline.foldEventTypes.includes('developer/message')) {
      test('host: developer messages contribute to requests and survive warm restore and v24 cache rebuild', () => {
        assert.equal(report.developerTokens, 35)
        assert.equal(report.developerRequestTokens, 35)
        assert.equal(report.developerRestoreMatches, true)
      })
    }

    test('host: hostile gateway usage keeps the served view schema-valid (issue #44)', () => {
      // Negative uncached input (cached_tokens > prompt_tokens), fractional
      // counts, string buckets, and a hostile NaN must all survive the REAL
      // registry's strict wire parse — billed from sanitized buckets, never frozen.
      assert.equal(report.hostileSnapshotOk, true)
      assert.equal(report.hostilePrompt, 161)
      assert.equal(report.hostileCacheRead, 151)
    })

    test('host: a poisoned upstream unit starves downstream units and throws the whole snapshot (dsh containment gap)', () => {
      // The registry drives every unit in ONE uncontained loop: the first
      // schema-invalid view throws out of drive() per event, units registered
      // after it stop receiving events entirely, and snapshot() — every
      // reconnect baseline — throws wholesale. The plugin cannot fix this
      // seam from outside; the probe pins the defect to the dsh generation.
      assert.ok(report.poisonedEscapedDrive >= 1)
      assert.equal(report.poisonedStarves, true)
      assert.equal(report.poisonedSnapshotThrows, true)
    })

    test('settings: the retired register face stays gone (the plugin never calls it)', () => {
      // The Config-form generation derives forms from each loader entry's own
      // Config schema; `settings.register` retired with the older lines. The
      // probe pins the absence, so a resurrection names the seam.
      assert.equal(
        staging.dshHasString(baseline.tag, 'register(', baseline.settings.serviceFile),
        baseline.settings.register,
        'the settings service register face',
      )
    })

    test('balance: the settings face and the DeepSeek provider row the facts fold reads', () => {
      // The balance route resolves the provider's settings row off the
      // Config-form `describe()` projection (the row matched by its own
      // apiKeyEnv-bearing section shape); the retired `get(ns)` section read
      // is asserted absent, so a moved seam names itself instead of silently hiding the capsule.
      const balance = baseline.balance
      assert.equal(
        staging.dshHasString(baseline.tag, balance.settingsGetNeedle, balance.settingsFile),
        balance.settingsGetPresent,
        'the settings service get face',
      )
      if (balance.settingsDescribeNeedle !== undefined) {
        assert.equal(
          staging.dshHasString(baseline.tag, balance.settingsDescribeNeedle, balance.settingsFile),
          true,
          'the settings service describe face',
        )
      }
      for (const provider of balance.providerFiles) {
        for (const needle of provider.needles) {
          assert.equal(staging.dshHasString(baseline.tag, needle, provider.file), true, `provider seam: ${needle}`)
        }
      }
    })

    test('host: the sliced cold fold faces exist (else the backfill falls back to whole-log blocks)', () => {
      // Issue #145: sessions over the slice threshold fold through these four
      // faces; a missing one silently returns that session to the single-shot
      // coldSnapshot path, so a removal must name itself here.
      const fold = baseline.backfillFold
      for (const [file, needle] of [
        [fold.registryFile, '  restore('],
        [fold.registryFile, '  hydrate('],
        [fold.storeFile, '  prepare('],
        [fold.cacheFile, '  async write('],
        [fold.cacheFile, '  coldSnapshot('],
      ] as const) {
        assert.equal(staging.dshHasString(baseline.tag, needle, file), true, `sliced-fold seam: ${needle} in ${file}`)
      }
    })

    for (const slot of staging.SLOT_SEAMS) {
      test(`client: slot "${slot}" exists`, () => {
        assert.equal(staging.dshHasString(baseline.tag, slot, 'packages/client/*/src/**'), true)
      })
    }

    test('client: the preferences card seat and transport match the generation', () => {
      // The keyed slot the browser half's card registers on and the settings
      // transport it rides: the Plugins page's `plugins.bundle.config` +
      // `configForms` on every supported line. Asserted BOTH ways (like the
      // sidebar seam) so a moved seam cannot read as "unsupported here" — a
      // slot the generation does not declare simply never receives the registration.
      const settings = baseline.settings
      assert.equal(
        settings.cardSlotFiles.some(pattern =>
          staging.dshHasString(baseline.tag, `'${settings.cardSlot}'`, pattern)),
        true,
        `the card slot "${settings.cardSlot}" is declared on this generation`,
      )
      assert.equal(
        staging.dshHasString(baseline.tag, `'${settings.transport}'`, settings.transportFile),
        settings.transportPresent,
        `the settings transport "${settings.transport}"`,
      )
    })

    test('client: the app frame carries the inline sidebar-leading grid track (modal dock seam, dockMeasure.ts)', () => {
      // dockMeasure reads the LEADING `Npx` track off the frame's inline
      // gridTemplateColumns; `px minmax(` pins a sidebar-first multi-track
      // template without pinning the newer generations' center/right spellings.
      assert.equal(
        staging.dshHasString(baseline.tag, 'px minmax(', 'packages/client/ui-layout/src/client/AppFrame.tsx'),
        true,
      )
    })

    test('client: finalized-nodes seat (useChat ChatSnapshot)', () => {
      assert.equal(staging.dshHasString(baseline.tag, 'useChat', 'packages/client/ui-chat/src/client/contract/slots.ts'), true)
    })

    test('client: durable-image loader service', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.imageFaceMethod, 'packages/client/*/src/**'), true)
    })

    test('client: the gateway history face of this generation', () => {
      assert.equal(staging.dshHasString(baseline.tag, "'remote.session'", 'packages/api/*/src/**'), true)
      // The service name alone is half the seam: historyPage's `rowsOf` rejects any payload without the
      // `records` envelope, so the transport's own spelling is pinned too.
      assert.equal(
        staging.dshHasString(baseline.tag, 'records: frame.records', 'packages/api/session-controller/src/client/transport.ts'),
        true,
        'the history page envelope key',
      )
    })

    test('detail channel: the Connection RPC faces and the registry stateOf exist', () => {
      const dc = baseline.client.detailChannel
      assert.equal(staging.dshHasString(baseline.tag, dc.hostRpcNeedle, dc.hostRpcFile), true, 'host RPC registry face')
      assert.equal(staging.dshHasString(baseline.tag, dc.clientRpcNeedle, dc.clientRpcFile), true, 'browser RPC caller face')
      assert.equal(staging.dshHasString(baseline.tag, dc.registryNeedle, dc.registryFile), true, 'registry stateOf face')
    })

    test('client: the right Sidebar tab seam', () => {
      const sidebar = baseline.client.sidebar
      assert.equal(staging.dshHasString(baseline.tag, sidebar.serviceNeedle, sidebar.serviceFile), true, 'tab-type registry service')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.slotNeedle, sidebar.slotFile), true, 'keyed body seat')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.titleSlotNeedle, sidebar.slotFile), true, 'keyed chip-title seat')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.nav.needle, sidebar.nav.file), true, 'resource navigation face (openResource)')
    })

    test('client: the right Sidebar guide-entry contract (the contribution\'s shape)', () => {
      for (const field of baseline.client.sidebar.guideEntry.fields) {
        assert.equal(staging.dshHasString(baseline.tag, field, baseline.client.sidebar.guideEntry.file), true, `guide-entry field: ${field}`)
      }
    })

    test('client: the session-jump seam of this generation (issue #90)', () => {
      // The view owner's navigation verb (the sidebar row click's own), with
      // the signature this line spells; and the retired sessions-service `open(id)` selection verb, probed staying gone.
      const nav = baseline.client.sessionNav
      assert.equal(
        staging.dshHasString(baseline.tag, nav.workspaceNeedle, nav.workspaceFile),
        true,
        'the view-owner navigation verb (uiWorkspace.openSession)',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, 'open(id: SessionId): void', nav.sessionsFile),
        nav.sessionsOpen,
        'the retired sessions-service selection verb',
      )
    })

    test('client: the first-level insight page seam (keyed main panel + sidebar panel list)', () => {
      const page = baseline.client.insightPage
      assert.equal(staging.dshHasString(baseline.tag, page.panellistNeedle, page.panellistFile), true, 'the sidebar panel-list seat')
      assert.equal(staging.dshHasString(baseline.tag, page.mainNeedle, page.mainFile), true, 'the layout\'s keyed main panel seat')
    })

    test('client: the slot-ledger read of the second-mount guard (dsh-context#137)', () => {
      const ledger = baseline.client.ledger
      assert.equal(
        staging.dshHasString(baseline.tag, ledger.needle, ledger.file),
        true,
        'the raw SlotCore.entries view',
      )
    })

    test('client: MarkdownText chrome prop', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.markdownChrome, 'packages/client/ui-primitives/src/markdown/MarkdownText.tsx'), true)
    })

    test('client: the JsonTree faces the rich-text JSON body rides', () => {
      const tree = baseline.client.jsonTree
      for (const needle of tree.needles) {
        assert.equal(staging.dshHasString(baseline.tag, needle, tree.file), true, `JsonTree seam: ${needle}`)
      }
      assert.equal(
        staging.dshHasString(baseline.tag, tree.cssNamingNeedle, tree.cssNamingFile),
        true,
        'the css-module naming the expanded-row preview rule matches',
      )
    })

    test('client: the icon seams resolve on this generation (primitives.ts)', () => {
      for (const name of staging.ICON_SEAMS) {
        const present = staging.dshHasString(baseline.tag, name, 'packages/client/ui-primitives/src/**')
        assert.equal(present, true, `icon seam: ${name}`)
      }
    })

    test('host: the fold\'s event vocabulary for this generation exists in the durable log', async () => {
      const known = await staging.knownEventTypesOf(baseline)
      const missing = baseline.foldEventTypes.filter(type => !known.has(type))
      assert.deepEqual(missing, [])
    })

    test('host: the step-boundary identity guard seam (issue #51)', () => {
      const sg = baseline.stepGuard
      for (const needle of sg.loopNeedles) {
        assert.equal(staging.dshHasString(baseline.tag, needle, sg.loopFile), true, `loop seam: ${needle}`)
      }
      assert.equal(
        staging.dshHasString(baseline.tag, 'prepend: true', sg.prependProofFile),
        true,
        'the prepend listener option the guard rides',
      )
    })

    test('host: the system-prompt injection seam', () => {
      // The prefix/suffix sections register through the prompt registry's
      // ordered-section face, anchored on its centrally owned order names,
      // and the preference edits ride the loader's volatile-only commit into
      // the running references — a moved seam names itself here instead of
      // silently dropping the configured text.
      const prompt = baseline.prompt
      assert.equal(
        staging.dshHasString(baseline.tag, prompt.sectionNeedle, prompt.serviceFile),
        true,
        'the ordered-section face',
      )
      for (const anchor of prompt.orderAnchors) {
        assert.equal(staging.dshHasString(baseline.tag, anchor, prompt.serviceFile), true, `order anchor: ${anchor}`)
      }
      assert.equal(
        staging.dshHasString(baseline.tag, prompt.loaderVolatileNeedle, prompt.loaderVolatileFile),
        true,
        'the loader volatile-only commit',
      )
    })

    test('client: platform module table answers every bundle require', async () => {
      const table = await staging.platformModulesOf(baseline)
      const unanswerable = staging.bundleRequires().filter(spec => !table.includes(spec))
      assert.deepEqual(unanswerable, [])
    })
  })
})
