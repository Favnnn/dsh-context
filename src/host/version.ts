/**
 * Runtime harness-version probe behind the baseline gate (host/index.ts).
 *
 * The probe never imports a harness package for its version; it reads manifests through Node
 * resolution from two anchors, in order:
 *
 *  1. This module's own ESM resolution of the library packages the Host half imports at runtime:
 *     the very pipeline the process resolves those imports through, so an embedding shell that
 *     redirects plugin imports redirects the probe identically. A witness inside this package's
 *     own tree is the plugin's dependency closure, never the harness, so it is discarded.
 *  2. The harness home's `profiles/node_modules` mirror (via the app-boot `dshHomePath` service),
 *     which names whichever installation last healed it.
 *
 * The `@deepseek-ai/dsh` CLI package is probed ONLY through the home anchor: the plugin never
 * imports it. Any failure degrades to `undefined`, and the gate treats an unknown version as
 * SATISFIED — a probe misfire must never blank a working deployment.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Library packages versioned in lockstep with the harness release. */
const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

/** Running-anchor probe order: the package the Host half imports at runtime first (host/fold.ts
 * imports it, so it MUST resolve whenever this plugin runs), then its sibling. */
const RUNNING_PROBE_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection'] as const

const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

/**
 * This package's root; a running-anchor witness under it belongs to the plugin's own dependency
 * closure, not to the harness.
 *
 * Located through the package's own `./package.json` self-reference, so the answer is the package
 * root in the source tree and in the bundled install alike. A loader that cannot self-resolve
 * falls back to this module's own directory: the guard covers less, but still cannot mistake the
 * plugin's own `node_modules` for the harness.
 */
function ownPackageRoot(): string {
  try {
    return dirname(fileURLToPath(import.meta.resolve('dsh-context/package.json')))
  } catch {
    /* v8 ignore next -- a loader that cannot resolve one of its own package's
       published subpaths is out of the suite's reach; the fallback keeps one
       probe path (an unanswered probe fails open either way). */
    return dirname(fileURLToPath(import.meta.url))
  }
}
const PLUGIN_ROOT = ownPackageRoot()

type Resolve = (specifier: string) => string
type ResolveUrl = (specifier: string) => string

function versionOfManifest(manifestPath: string, expectedName?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as { name?: unknown; version?: unknown }
    if (expectedName !== undefined && record.name !== expectedName) return undefined
    return typeof record.version === 'string' && record.version !== '' ? record.version : undefined
  } catch {
    return undefined
  }
}

function versionViaManifest(resolve: Resolve, packageName: string): string | undefined {
  try {
    return versionOfManifest(resolve(packageName + '/package.json'))
  } catch {
    // The export map publishes no such subpath (or the package is absent).
    return undefined
  }
}

/** Probe via the package's entry point, ascending to its owning manifest: packaged-executable
 * proxies carry the real version but export only entry stubs, and Node's exports gate refuses the
 * direct `./package.json` subpath. */
function versionViaEntry(resolve: Resolve, packageName: string): string | undefined {
  let dir: string
  try {
    dir = dirname(resolve(packageName))
  } catch {
    return undefined
  }
  for (;;) {
    const version = versionOfManifest(join(dir, 'package.json'), packageName)
    if (version !== undefined) return version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function probeAnchor(resolve: Resolve, packageNames: readonly string[]): string | undefined {
  for (const packageName of packageNames) {
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/** Whether `candidate` lies inside `root`'s tree. A `..`-prefixed relative path escapes it, and a
 * cross-drive `relative()` returns an absolute path, rejected the same way. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** The running module tree's answer, or undefined when it cannot be trusted: a witness inside the
 * plugin's own closure is the plugin's dependency, and a trusted witness whose manifest cannot be read is no answer either. */
function probeRunningTree(resolve: Resolve, pluginRoot: string): string | undefined {
  for (const packageName of RUNNING_PROBE_PACKAGES) {
    let witness: string
    try {
      witness = resolve(packageName)
    } catch {
      // Absent from this anchor; the next package may still answer.
      continue
    }
    if (isInside(pluginRoot, witness)) continue
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

function resolveRunningModule(specifier: string): string {
  return import.meta.resolve(specifier)
}

export function detectHarnessVersion(
  ctx: Context,
  resolveUrl: ResolveUrl = resolveRunningModule,
  pluginRoot: string = PLUGIN_ROOT,
): string | undefined {
  // A non-file URL (an exotic loader) names no manifest on disk, so the home anchor answers.
  const running = probeRunningTree((specifier) => {
    const url = resolveUrl(specifier)
    if (!url.startsWith('file:')) throw new Error(`dsh-context: non-file module URL for ${specifier}`)
    return fileURLToPath(url)
  }, pluginRoot)
  if (running !== undefined) return running
  try {
    // The app-boot home resolver; an absent or hostile service leaves the probe unanswered.
    const homePath = ctx.get('dshHomePath') as unknown
    if (typeof homePath === 'function') {
      const req = createRequire((homePath as (...segments: string[]) => string)('profiles', 'dsh-context-version-probe.cjs'))
      const home = probeAnchor(specifier => req.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch { /* nothing answered; the gate fails open */ }
  return undefined
}
