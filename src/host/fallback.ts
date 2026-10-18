/**
 * The baseline gate's fallback projection units (see host/index.ts).
 *
 * On a harness below the supported baseline the plugin registers these INSTEAD of the real
 * folds: nothing is parsed at all — `apply` is the identity over an opaque empty state, and
 * `view` serves a fixed value whose timeline snapshot carries the gate record (`unsupported`:
 * the detected harness version and the baseline), so the client renders blank cards and its gate
 * modal.
 *
 * The definition also carries the pre-0.1.1 top-level `schema` + `view` aliases those harnesses' registry reads
 * instead of `stateSchema` + `wire`. They serve only harnesses outside the support matrix (docs/compatibility.md),
 * where this gate is the entire plugin behaviour.
 *
 * `stateVersion` is pinned at 1: a downgrade refolds the timeline key and seeds the headers key
 * stripped to the empty state (which the gate never reads); an upgrade back discards or rejects
 * the fallback rows and refolds both from the log.
 */

import { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ProjectionDefinition } from './compat'
import { BASELINE_DSH_VERSION } from '../shared/version'
import { contextActivitySchema } from './activity'
import { contextHeadersSchema } from './headers'
import { contextTimelineSchema } from './timeline'

/** The opaque fold state: the gate folds nothing, so any cached row seeds it (strip mode, never
 * a discard or a throw) and the plain-JSON cache-write gate trivially holds. */
const fallbackStateSchema = z.object({})
type FallbackState = z.infer<typeof fallbackStateSchema>

/** The pre-0.1.1 registry contract's fields (see the header note). */
interface LegacyDefinitionShape<V> {
  schema: z.ZodType<V>
  view(state: FallbackState): V
}

function fallbackDefinition<K extends 'contextTimeline' | 'contextHeaders' | 'contextActivity'>(
  key: K,
  wireSchema: z.ZodType<SessionProjectionMap[K]>,
  value: SessionProjectionMap[K],
): ProjectionDefinition<K, FallbackState> & LegacyDefinitionShape<SessionProjectionMap[K]> {
  const view = (): SessionProjectionMap[K] => value
  return {
    key,
    stateSchema: fallbackStateSchema,
    init: () => ({}),
    apply: state => state,
    wire: { viewSchema: wireSchema, view },
    schema: wireSchema,
    view,
    stateVersion: 1,
  }
}

export function createFallbackTimelineDefinition(current: string) {
  return fallbackDefinition('contextTimeline', contextTimelineSchema, {
    ok: true,
    unsupported: { current, minimum: BASELINE_DSH_VERSION },
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  })
}

export function createFallbackHeadersDefinition() {
  return fallbackDefinition('contextHeaders', contextHeadersSchema, { headers: [] })
}

export function createFallbackActivityDefinition() {
  return fallbackDefinition('contextActivity', contextActivitySchema, { days: {} })
}
