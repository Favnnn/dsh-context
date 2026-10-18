/**
 * The host-wide cold-read governor (issue #121).
 *
 * Every cold read (the warm-up pass's per-session fold, the detail route's cold rung)
 * materializes a whole durable log: the persistence backend decodes every frame before it can
 * slice one event, so a 10k-event session lands as a several-hundred-MB object graph. The gate
 * admits one read at a time (FIFO) and only while the heap leaves headroom; a skipped read
 * takes the caller's designed no-data path, never a visible failure.
 */

import { getHeapStatistics } from 'node:v8'

export interface HeapReading {
  used: number
  limit: number
}

/** The admission face both cold paths share. */
export interface ColdReadGate {
  /** Resolves `undefined` when the read was skipped under pressure — the caller's own no-data path answers instead. */
  admit<T>(read: () => Promise<T>): Promise<T | undefined>
}

/** A cold read starts only below two-thirds of the process's own V8 ceiling, leaving the top
 * third for the read itself plus the harness's own decoded-log floors. */
const HIGH_WATER = 2 / 3

function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

const noop = (): void => {}

/** One governor per host process, shared by both cold paths. `reading` is injectable for
 * tests; a throwing or garbage probe fails OPEN — the meter must never block a read. */
export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  let tail: Promise<unknown> = Promise.resolve()
  return {
    admit<T>(read: () => Promise<T>): Promise<T | undefined> {
      // The headroom check runs at the front of the queue, not at queue time — pressure changes while waiting.
      const run = tail.then(() => (clear() ? read() : undefined))
      tail = run.then(noop, noop)
      return run
    },
  }
}
