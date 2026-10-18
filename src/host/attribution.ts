/// <reference types="node" />
/**
 * Live tool→plugin attribution layered on the static recovery in toolSources.ts.
 *
 * The session log records tools as plain `ToolSchema` entries, so the registering plugin is not
 * in there. This module watches RUNTIME registrations: cordis fires the `internal/get` waterfall
 * on every context read of a service property, passing the READING context first, so
 * `reader.fiber.name` identifies the plugin about to call `register()`.
 *
 * - The handler records that fiber NAME — a scalar, never the reader context, which would pin
 *   the caller's whole agent past disposal — and wraps the tools service's `register` to capture
 *   the reader. Cordis hands out a fresh traced proxy per read, so the proxy is peeled to its
 *   stable instance, and a reload peels a previous incarnation's wrapper back to the original so
 *   wrappers never stack; every wrapper is undone on unload.
 * - When the reader slot is missing, root-named, or this plugin's own (local links fall back to
 *   the root name), the wrapped `register` resolves the caller from the stack instead: the first
 *   frame outside this package, mapped to its nearest package.json `name`.
 * - `ownerOf(name)` prefers the name-derived `mcp:<server>` label, then the live record, then the
 *   pinned map, and tags boot-predating tools `UNKNOWN_TOOL_SOURCE` — their plugin is unknowable,
 *   where a bare gap would read as "no plugin".
 *
 * Best-effort: a read separated from `register()` by an `await` can be overwritten by another
 * plugin's read, and the stack fallback needs a resolvable package.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../shared/types'
import { mcpSourceOf, pinnedSourceOf } from './toolSources'

export interface ToolAttribution {
  ownerOf(name: string): string | undefined
}

const selfUrl = normalize(fileURLToPath(import.meta.url))

/** Directory → package-name cache for the walk below. */
const packageCache = new Map<string, string | undefined>()

/**
 * Best-effort package name for a module file: the nearest `package.json` carrying a `name`.
 * @param file - absolute path of a module file.
 */
export function packageNameFrom(file: string): string | undefined {
  let dir = dirname(file)
  for (let depth = 0; depth < 12; depth++) {
    const cached = packageCache.get(dir)
    if (cached !== undefined) return cached
    const packageFile = join(dir, 'package.json')
    if (existsSync(packageFile)) {
      try {
        const name = (JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }).name
        if (typeof name === 'string' && name) {
          packageCache.set(dir, name)
          return name
        }
      } catch {
        // Malformed or unreadable package.json — keep walking up.
      }
    }
    const parent = dirname(dir)
    packageCache.set(dir, undefined)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

const FRAME_POSITION = /:\d+:\d+$/

/** Symbol cordis registers (`Symbol.for`) on its traced proxies; reading it yields the wrapped target. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Peel cordis's per-read traced proxy (dsh's ToolRuntime hands one out per `ctx.tools` read)
 * down to the instance it wraps, so identity-keyed bookkeeping sees one stable object.
 * @param tools - the value as handed out by a context read.
 */
function rawInstanceOf(tools: unknown): unknown {
  const raw = (tools as { [key: symbol]: unknown } | undefined | null)?.[CORDIS_ORIGINAL]
  return raw ?? tools
}

const selfPackage = packageNameFrom(selfUrl)

/**
 * Resolve the registering package from a stack trace: the package name of the first frame
 * outside this package, in both `file://` and bare-path forms.
 * @param stack - `Error().stack`, or undefined when no fallback is desired.
 */
export function callerPackageFrom(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  for (const raw of stack.split('\n').slice(1)) {
    let line = raw.trim()
    if (!line.startsWith('at ')) continue
    line = line.slice(3)
    if (line.startsWith('async ')) line = line.slice(6)
    line = line.replace(/\)\s*$/, '')
    const position = FRAME_POSITION.exec(line)
    if (!position) continue
    let target = line.slice(0, -position[0].length)
    if (target.includes('(')) {
      target = target.slice(target.lastIndexOf('(') + 1)
    }
    if (target.startsWith('file://')) {
      try {
        target = normalize(fileURLToPath(target))
      } catch {
        continue
      }
    } else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith('/') && !target.startsWith('\\\\')) {
      continue
    } else {
      target = normalize(target)
    }
    if (target === selfUrl) continue
    const name = packageNameFrom(target)
    if (name !== undefined && name !== selfPackage) return name
  }
  return undefined
}

interface ToolServiceLike {
  layers?: {
    global?: {
      tools?: {
        entries?: () => Iterable<[string, unknown]>
      }
    }
  }
}

/**
 * Install the runtime-attribution hook on a cordis app context; it rides the calling fiber's
 * lifetime and is disposed with the plugin.
 * @param ctx - the context the dsh-context plugin runs in; its fiber name is excluded.
 */
export function createToolAttribution(ctx: Context): ToolAttribution {
  const live = new Map<string, string>()
  const wrapped = new WeakSet()
  const self = ctx.fiber.name
  // Only the reader's fiber NAME: a retained context would pin its whole agent past disposal.
  let lastReader: string | undefined
  // Restore closures for every instance this incarnation patched (run by the unload effect).
  const patched: (() => void)[] = []

  const wrapInstance = (tools: unknown) => {
    if (!tools || typeof tools !== 'object' || wrapped.has(tools)) return
    const register = (tools as { register?: unknown }).register
    if (typeof register !== 'function') return
    wrapped.add(tools)
    // A reload re-installs the hook on a still-wrapped instance: peel the previous
    // incarnation's wrapper so wrappers never stack.
    const original = (register as { attributedOriginal?: unknown }).attributedOriginal ?? register
    if (typeof original !== 'function') return
    const instance = tools as { register: (this: unknown, definition?: { name?: unknown }) => unknown }
    const wrappedRegister = function (this: unknown, definition?: { name?: unknown }) {
      const toolName = definition?.name
      let owner = lastReader
      if (!owner || owner === 'root' || owner === self) {
        owner = callerPackageFrom(new Error().stack)
      }
      const dispose = (original as (this: unknown, definition?: unknown) => unknown).call(this, definition)
      if (typeof toolName === 'string' && owner && owner !== 'root' && owner !== self && owner !== selfPackage) {
        live.set(toolName, owner)
        if (typeof dispose === 'function') {
          return () => {
            try {
              return (dispose as () => unknown)()
            } finally {
              live.delete(toolName)
            }
          }
        }
      }
      return dispose
    }
    ;(wrappedRegister as { attributedOriginal?: unknown }).attributedOriginal = original
    instance.register = wrappedRegister
    patched.push(() => {
      if (instance.register === wrappedRegister) instance.register = original as typeof instance.register
    })
  }

  ctx.on('internal/get', (reader, name, _error, next) => {
    if (name !== 'tools') return next() as unknown
    const tools = next() as unknown
    // Patch the stable instance but return the caller's own proxy: its this-binding carries the
    // reading context's scoped registration semantics.
    lastReader = reader.fiber.name
    wrapInstance(rawInstanceOf(tools))
    return tools
  })

  // Unloading peels every wrapper this incarnation installed; a closure finding a newer
  // incarnation's wrapper does nothing — that incarnation owns the restore.
  ctx.effect(() => () => {
    for (const restore of patched.splice(0)) restore()
  }, 'tools.register attribution')

  // An instance provided before this plugin started is still wrapped for later registrations;
  // the tools it already holds registered before the hook could observe them, so their provider
  // is unknowable and the boot snapshot tags them UNKNOWN_TOOL_SOURCE instead of nothing.
  const toolsService = rawInstanceOf(ctx.get('tools', false)) as ToolServiceLike | undefined
  wrapInstance(toolsService)
  const boot = new Set<string>()
  try {
    const toolEntries = toolsService?.layers?.global?.tools
    // Method-style call: `entries()` reads `this.data`, so the receiver must be preserved; any
    // shape surprise leaves the boot snapshot empty (attribution must never break startup).
    if (toolEntries !== undefined && typeof toolEntries.entries === 'function') {
      for (const [name] of toolEntries.entries()) boot.add(name)
    }
  } catch {
    // Unsupported tool-service internals — degrade to no boot snapshot.
  }

  return {
    ownerOf: name =>
      mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name)
        ?? (boot.has(name) ? UNKNOWN_TOOL_SOURCE : undefined),
  }
}
