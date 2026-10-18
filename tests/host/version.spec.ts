// Fixture roots:  - tests/host/fixtures/version/homes/* — committed homes whose packages
//    RESOLVE at the fixture level (no walk-up), shared with index.spec.ts.
//  - a per-run tree under os.tmpdir() — the FAILURE cases and the
//    running-tree fixtures. They must sit outside the repository: a failing
//    probe inside the repo tree would walk up into the repo's own node_modules
//    and answer with the pinned devDependencies instead of failing, and a
//    running-tree witness inside the repo would read as this package's own    dependency closure.
//  Walk-up cleanliness alone is not hermetic, though: CJS resolution consults
//  NODE_PATH after the walk-up fails, and a pnpm-managed environment (a
//  `pnpm` binary from a sibling checkout) injects that checkout's virtual
//  store into NODE_PATH — an AMBIENT harness install every absent probe
//  package would otherwise resolve to. Every home therefore SHADOWS each
//  package its failing probes could reach (see `shadow` in beforeAll): the
//  resolution answers at the fixture level with an entry that names the
//  package but carries no version, so both probe paths (manifest subpath via
//  the exports gate, entry ascend via the versionless own manifest) yield
//  undefined and the degradation arms stay machine-independent.
// The running anchor is injected as a URL resolver, and the plugin root as a
// path, so both the trusted and the own-closure arms are exercised hermetically.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { detectHarnessVersion } from '../../src/host/version'

const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

const resolverIn = (root: string) => (...segments: string[]): string => join(root, ...segments)
const homeResolver = (home: string): (...segments: string[]) => string => resolverIn(join(HOMES, home))

function ctxWithHome(homePath: unknown): Context {
  const ctx = new Context()
  ctx.provide('dshHomePath', homePath)
  return ctx
}

/** The running anchor's URL resolver: real Node resolution from one fixture home's profiles dir,
 * as an installed plugin's own module pipeline would perform it. */
function runningResolver(home: string, root: string = HOMES): (specifier: string) => string {
  const anchor = join(root, home, 'profiles', 'running-probe.cjs')
  return specifier => pathToFileURL(createRequire(anchor).resolve(specifier)).href
}

const NO_RUNNING = (): string => { throw new Error('no running module tree') }

/** A plugin root holding no fixture tree; it sits beside (never above) the scratch root. */
const ELSEWHERE = join(tmpdir(), 'dsh-context-plugin-root')

const fixedUrl = (url: string) => (): string => url

let scratch = ''

/** Write one scratch probe home; `decoyManifest` is a mismatched manifest placed beside the exports entry. */
function writeScratchHome(
  home: string,
  packageName: string,
  manifest: string,
  entry?: { path: string; decoyManifest?: string },
): string {
  const dir = join(scratch, home, 'profiles', 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest)
  if (entry !== undefined) {
    const entryPath = join(dir, entry.path)
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(entryPath, '')
    if (entry.decoyManifest !== undefined) {
      writeFileSync(join(dirname(entryPath), 'package.json'), entry.decoyManifest)
    }
  }
  return join(scratch, home)
}

const scratchResolver = (home: string): (...segments: string[]) => string => resolverIn(join(scratch, home))

/** A probe-package shadow: the package RESOLVES at the fixture level — so the walk-up and the
 * NODE_PATH ambient installs behind it are never consulted — but answers NO version: the manifest
 * subpath probe dies on the exports gate, the entry ascend reads a versionless own manifest. */
function shadow(home: string, packageName: string): void {
  writeScratchHome(home, packageName,
    JSON.stringify({ name: packageName, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-context-version-'))
  // Scratch, not the repo tree: inside it a missing CLI package could resolve to an ambient install
  // above the repo (e.g. a global copy under ~/node_modules), making the answer machine-dependent.
  shadow('library-only', '@deepseek-ai/dsh')
  writeScratchHome('library-only', '@deepseek-ai/dsh-session-projection',
    JSON.stringify({ name: '@deepseek-ai/dsh-session-projection', version: '0.1.1-rc.2' }))
  writeScratchHome('entry-only', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('entry-nested', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.4', exports: { '.': './a/b/index.js' } }),
    { path: 'a/b/index.js', decoyManifest: JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9' }) })
  // Odd manifests sit as DECOYS on the ascend path: only the direct
  // manifest read (not a resolve) ever surfaces them, and the probe must skip each to reach the owning package's version.
  writeScratchHome('entry-badjson', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.5', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'not json{' })
  writeScratchHome('entry-null', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.6', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'null' })
  writeScratchHome('entry-primitive', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.7', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: '"oops"' })
  writeScratchHome('entry-gone', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.8', exports: { '.': './lib/gone.js' } }))
  shadow('entry-gone', '@deepseek-ai/dsh-session-projection')
  shadow('entry-gone', '@deepseek-ai/dsh-session')
  writeScratchHome('entry-orphan', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-orphan', version: '1.0.0', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('entry-orphan', '@deepseek-ai/dsh')
  shadow('entry-orphan', '@deepseek-ai/dsh-session-projection')
  // The invalid-version homes: the manifest subpath probe reads the odd
  // version and rejects it; the entry ascend resolves the shadowed entry and
  // rejects the own manifest again — nothing may fall through to NODE_PATH.
  writeScratchHome('nonstring-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: 42, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('nonstring-version', '@deepseek-ai/dsh-session-projection')
  shadow('nonstring-version', '@deepseek-ai/dsh-session')
  writeScratchHome('empty-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('empty-version', '@deepseek-ai/dsh-session-projection')
  shadow('empty-version', '@deepseek-ai/dsh-session')
  mkdirSync(join(scratch, 'empty', 'profiles'), { recursive: true })
  shadow('empty', '@deepseek-ai/dsh')
  shadow('empty', '@deepseek-ai/dsh-session-projection')
  shadow('empty', '@deepseek-ai/dsh-session')
  // Running-anchor trees: a supported release (the Desktop fix), a below-
  // baseline release, and a resolving-but-unreadable library.
  writeScratchHome('running-supported', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.7-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  // The just-dropped line: below the baseline since the floor moved to 0.1.7-rc.2, so the gate must trip on it.
  writeScratchHome('running-old', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.5-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-decoy', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  // The decoy home's witness must resolve to NOTHING trusted: shadow the
  // other spelling too, or an ambient install would answer in its place.
  shadow('running-decoy', '@deepseek-ai/dsh-session-projection')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectHarnessVersion — running anchor', () => {
  test('outranks a stale home mirror (issue #59: a healthy Desktop harness)', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('old')), runningResolver('running-supported', scratch), ELSEWHERE), '0.1.7-rc.2')
  })

  test('a below-baseline running tree still trips the gate over a newer mirror', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('future')), runningResolver('running-old', scratch), ELSEWHERE), '0.1.5-rc.1')
  })

  test('discards a witness inside this package own closure for the home anchor', () => {
    // A `link:`-installed dev checkout resolves its own pinned devDependencies:
    // that closure is not the harness, so the home mirror answers instead. The
    // default package root (the real one, which contains the repo's node_modules) performs the discard.
    const ctx = ctxWithHome(homeResolver('old'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli')), '0.1.5-rc.1')
  })

  test('never probes the CLI package from the running anchor', () => {
    // The fixture pins the CLI at 0.0.1 but the libraries at the baseline: only a library answer may come back.
    const ctx = ctxWithHome(scratchResolver('empty'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli'), ELSEWHERE), '0.1.7-rc.2')
  })

  test('a resolving witness with no readable version falls through to home', () => {
    // The library resolves, so the witness is trusted, but its manifest name
    // never matches: the anchor yields nothing and home answers.
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('running-decoy', scratch), ELSEWHERE), '0.2.0')
  })

  test('a non-file running URL is no answer', () => {
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, fixedUrl('data:text/javascript,'), ELSEWHERE), '0.2.0')
  })

  test('classifies the plugin root and its parent correctly', () => {
    // A witness equal to the plugin root is inside it (the `relative` result is
    // empty); a witness one level above is reached through `..`.
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), ELSEWHERE), '0.2.0')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), join(ELSEWHERE, 'inner')), '0.2.0')
  })
})

describe('detectHarnessVersion — home anchor', () => {
  test('reads the CLI package manifest of the running installation', () => {
    const ctx = (home: string) => ctxWithHome(homeResolver(home))
    assert.equal(detectHarnessVersion(ctx('old'), NO_RUNNING), '0.1.5-rc.1')
    assert.equal(detectHarnessVersion(ctx('baseline'), NO_RUNNING), '0.1.7-rc.2')
    assert.equal(detectHarnessVersion(ctx('future'), NO_RUNNING), '0.2.0')
    assert.equal(detectHarnessVersion(ctx('dev'), NO_RUNNING), '0.0.0-dev')
  })

  test('falls through to the library packages when the CLI row is absent', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('library-only')), NO_RUNNING), '0.1.1-rc.2')
  })

  test('ascends from the entry point when the manifest subpath is not exported', () => {
    const ctx = ctxWithHome(scratchResolver('entry-only'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), '0.1.1-rc.1')
  })

  test('skips mismatched manifests while ascending to the owning package', () => {
    const ctx = ctxWithHome(scratchResolver('entry-nested'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), '0.1.1-rc.4')
  })

  test('skips invalid, null, and primitive manifests met while ascending', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-badjson')), NO_RUNNING), '0.1.1-rc.5')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-null')), NO_RUNNING), '0.1.1-rc.6')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-primitive')), NO_RUNNING), '0.1.1-rc.7')
  })

  test('an entry the exports map names but the package does not ship → undefined', () => {
    // The entry resolve fails AT the fixture level (the promised file is
    // absent): no ascend, no answer, no NODE_PATH fall-through.
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-gone')), NO_RUNNING), undefined)
  })
})

describe('detectHarnessVersion — degradation arms (fail open)', () => {
  test('no running tree and no home service → undefined', () => {
    assert.equal(detectHarnessVersion(new Context(), NO_RUNNING), undefined)
  })

  test('a non-function dshHomePath is ignored', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(42), NO_RUNNING), undefined)
  })

  test('a home resolver that throws yields undefined', () => {
    const ctx = ctxWithHome(() => { throw new Error('hostile home') })
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('a hostile ctx.get yields undefined', () => {
    const hostile = { get() { throw new Error('hostile ctx') } } as unknown as Context
    assert.equal(detectHarnessVersion(hostile, NO_RUNNING), undefined)
  })

  test('the default running anchor discards this package own devDependencies', () => {
    // In the repository the default anchor resolves the repo's pinned
    // devDependencies, which live inside this package's tree: nothing is
    // trusted and there is no home service, so the probe answers undefined
    // (the gate fails open) instead of reading the repo's devDependencies.
    assert.equal(detectHarnessVersion(new Context()), undefined)
  })

  test('a resolving package whose manifest never matches → undefined', () => {
    const ctx = ctxWithHome(scratchResolver('entry-orphan'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('unreadable/invalid/odd manifests all degrade to undefined', () => {
    for (const home of ['nonstring-version', 'empty-version', 'empty']) {
      const ctx = ctxWithHome(scratchResolver(home))
      assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined, home)
    }
  })
})
