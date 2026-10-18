// A faithful in-memory implementation of the harness client context the plugin's `apply` consumes: every member
// implements the DOCUMENTED contract (cordis effect/inject semantics, locale fallback chain, slot registry,
// sessions scope) rather than a test-specific stub, so specs assert through the same seams production uses.

import type { ClientCtx, LocaleService, SlotRegistration, SlotsService } from '../../../src/client/services'
import { makeTranslate } from './kit'

export interface SlotEntry {
  registration: SlotRegistration
  component: (props: { sessionId?: string } & Record<string, unknown>) => unknown
}

export class TestSlots implements SlotsService {
  readonly seated: SlotEntry[] = []

  inject(_name: string, callback: () => unknown): unknown {
    // slots.inject is a declaration injection riding the caller's effect:
    // the callback runs synchronously and returns the register() disposer.
    return callback()
  }

  register(registration: SlotRegistration, component: (props: { sessionId?: string } & Record<string, unknown>) => unknown): unknown {
    const entry: SlotEntry = { registration, component }
    this.seated.push(entry)
    return () => {
      const i = this.seated.indexOf(entry)
      if (i >= 0) this.seated.splice(i, 1)
    }
  }

  /** The raw ledger view (`SlotRegistry.entries`): one stored record per seated
   * entry of the slot, `options` carrying the registered cell fields — the shape
   * the session header reads and the second-mount guard proves against. */
  entries(name: string): {
    component: SlotEntry['component']
    options: { key?: string; id?: string; order?: number; priority?: number }
    locale?: string
  }[] {
    return this.of(name).map(e => ({
      component: e.component,
      options: {
        ...(e.registration.key !== undefined ? { key: e.registration.key } : {}),
        ...(e.registration.id !== undefined ? { id: e.registration.id } : {}),
        ...(e.registration.order !== undefined ? { order: e.registration.order } : {}),
      },
      ...(e.registration.locale !== undefined ? { locale: e.registration.locale } : {}),
    }))
  }

  /** Every registration for a slot name (list slots keep several). */
  of(name: string): SlotEntry[] {
    return this.seated.filter(e => e.registration.name === name)
  }
}

export class TestLocale implements LocaleService {
  readonly namespaces = new Map<string, Record<string, Record<string, string>>>()
  /** The selectable-language catalog, mirroring the runtime's registration order. */
  readonly catalog = new Map<string, { id: string; label: string }>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  active = 'en'

  register(ns: string, localeOrDicts: string | Record<string, Record<string, string>>, dict?: Record<string, string>): () => void {
    if (typeof localeOrDicts === 'string') {
      const locale = localeOrDicts
      if (dict === undefined) throw new Error('single-locale register needs a dict')
      const owner = this.namespaces.get(ns) ?? {}
      if (owner[locale] !== undefined) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      this.namespaces.set(ns, { ...owner, [locale]: dict })
      return () => {
        const current = this.namespaces.get(ns)
        if (current?.[locale] !== dict) return
        const next = { ...current }
        delete next[locale]
        if (Object.keys(next).length === 0) this.namespaces.delete(ns)
        else this.namespaces.set(ns, next)
      }
    }
    this.namespaces.set(ns, localeOrDicts)
    return () => {
      this.namespaces.delete(ns)
    }
  }

  bind(ns: string): (key: string, params?: Record<string, string | number>) => string {
    return makeTranslate(this.active as 'en' | 'zh' | 'ru', this.namespaces.get(ns))
  }

  getLocale(): { active: string; locales: { id: string; label: string }[]; revision: number } {
    return {
      active: this.active,
      locales: [...this.catalog.values()],
      revision: this.revision,
    }
  }

  setLocale(id: string): void {
    if (!this.catalog.has(id) && !['en', 'zh'].includes(id)) throw new Error(`locale "${id}" is not registered`)
    if (this.active === id) return
    this.active = id
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }

  addLanguage(input: { id: string; label: string; fallback: string }): () => void {
    if (this.catalog.has(input.id)) throw new Error(`locale "${input.id}" is already registered`)
    if (!['en', 'zh'].includes(input.fallback) && !this.catalog.has(input.fallback)) {
      throw new Error(`locale fallback "${input.fallback}" is not registered`)
    }
    this.catalog.set(input.id, { id: input.id, label: input.label })
    return () => {
      this.catalog.delete(input.id)
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export interface TestClientCtxOptions {
  locale?: 'en' | 'zh' | 'ru'
  services?: Record<string, unknown>
}

/** A client ctx with cordis semantics: `inject` runs its callback once every
 * requested service exists (services are armed via options.services or
 * setService — arming later replays pending callbacks, like cordis), and
 * `effect` collects disposers that `dispose()` runs LIFO. */
export class TestClientCtx {
  readonly slots = new TestSlots()
  readonly locale: TestLocale
  private readonly services = new Map<string, unknown>()
  private readonly pending: { deps: string[]; cb: (ctx: TestClientCtx) => (() => void) | void }[] = []
  private readonly disposers: (() => void)[] = []

  constructor(options: TestClientCtxOptions = {}) {
    this.locale = new TestLocale()
    this.locale.active = options.locale ?? 'en'
    for (const [k, v] of Object.entries(options.services ?? {})) this.setService(k, v)
  }

  get(name: string): unknown {
    return this.services.get(name)
  }

  setService(name: string, service: unknown): void {
    this.services.set(name, service)
    // Cordis surfaces services as context properties (ctx.configForms …).
    if (!(name in this)) {
      Object.defineProperty(this, name, { get: () => this.services.get(name), configurable: true })
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.deps.every(d => this.services.has(d))) {
        this.pending.splice(i, 1)
        p.cb(this)
      }
    }
  }

  /** Cordis semantics: an inject gets its fiber handle as soon as it is
   * declared (PENDING while a service is still missing) — disposing it either
   * cancels the pending wait or unwinds the loaded callback, and the loaded
   * disposer also belongs to the context's own dispose (LIFO). Either path retires it, so the two lifetimes never run it twice.
   */
  inject(deps: string[] | Record<string, unknown>, cb: (ctx: TestClientCtx) => (() => void) | void): { dispose: () => Promise<void> } {
    const list = Array.isArray(deps) ? deps : Object.keys(deps)
    let ran = false
    let disposed = false
    let retired = false
    let inner: (() => void) | undefined
    const fiber = {
      dispose: async () => {
        if (disposed) return
        disposed = true
        const i = this.pending.findIndex(p => p.cb === wrapped)
        if (i >= 0) {
          this.pending.splice(i, 1)
          return
        }
        if (ran && inner !== undefined && !retired) {
          inner()
        }
      },
    }
    const wrapped = (ctx: TestClientCtx): void => {
      ran = true
      const dispose = cb(ctx)
      if (typeof dispose === 'function') {
        inner = () => {
          if (retired) return
          retired = true
          dispose()
        }
        this.disposers.push(inner)
      }
    }
    if (list.every(d => this.services.has(d))) wrapped(this)
    else this.pending.push({ deps: list, cb: wrapped })
    return fiber
  }

  effect(fn: () => (() => void) | void, _label?: string): () => void {
    const dispose = fn()
    const d = typeof dispose === 'function' ? dispose : () => {}
    this.disposers.push(d)
    return d
  }

  dispose(): void {
    while (this.disposers.length > 0) this.disposers.pop()?.()
  }
}

export function asClientCtx(ctx: TestClientCtx): ClientCtx {
  return ctx as unknown as ClientCtx
}

/** A real sessions face with the documented scope contract. */
export class TestSessions {
  readonly bails: { scope: unknown; event: string; payload: unknown }[] = []

  scope(_id: string): { bail(subject: unknown, event: string, payload: unknown): boolean } | undefined {
    return {
      bail: (subject, event, payload) => {
        this.bails.push({ scope: subject, event, payload })
        return true
      },
    }
  }
}
