/**
 * Session-projection unit contract compatibility layer.
 *
 * The installed dsh types pin the oldest supported surface (0.1.7-rc.2), whose optional
 * `wire?` fails the registry's wired-register overload, so the contract is mirrored here as
 * {@link ProjectionDefinition} to keep both halves compile-checked.
 */

import type { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session-projection unit contract served by dsh 0.1.7-rc.2+ (local mirror). */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K
  /** Validates persisted state before a checkpoint row seeds a fold; the state must stay plain JSON. */
  stateSchema: z.ZodType<S>
  /** The registry passes the session header and the fork-inherited prefix length; a zero-argument init leaves both unobserved. */
  init(): S
  /** Pure transition; an ignored event MUST return the same state reference. */
  apply(state: S, event: SessionEvent): S
  /** Client-visible units only: a unit without `wire` is host-only, so its value never reaches the browser. */
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  }
  stateVersion: number
}
