// The cold-read governor (src/host/coldRead.ts, issue #121): FIFO exclusion across concurrent admits and
// the two-thirds high-water skip, checked when the read reaches the FRONT of the queue — not when queued.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { type HeapReading, makeColdReadGate } from '../../src/host/coldRead'

const LOW: HeapReading = { used: 100, limit: 1000 }
const HIGH: HeapReading = { used: 800, limit: 1000 }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('makeColdReadGate', () => {
  test('concurrent reads run one at a time, in queue order', async () => {
    const gate = makeColdReadGate(() => LOW)
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const task = (name: string, gate2?: Promise<string>): (() => Promise<string>) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push(`${name}:start`)
      const value = await (gate2 ?? Promise.resolve(name))
      order.push(`${name}:end`)
      active--
      return value
    }
    const blocker = deferred<string>()
    const first = gate.admit(task('a', blocker.promise))
    const second = gate.admit(task('b'))
    const third = gate.admit(task('c'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['a:start'], 'the queued reads wait for the front')
    blocker.resolve('A')
    assert.deepEqual(await Promise.all([first, second, third]), ['A', 'b', 'c'])
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
    assert.equal(maxActive, 1, 'never two reads in flight')
  })

  test('a read over the high-water mark is skipped, not run', async () => {
    const gate = makeColdReadGate(() => HIGH)
    let ran = 0
    const value = await gate.admit(async () => {
      ran++
      return 42
    })
    assert.equal(value, undefined)
    assert.equal(ran, 0, 'the read never started')
  })

  test('the headroom check runs at the front of the queue, not at queue time', async () => {
    let reading = LOW
    const gate = makeColdReadGate(() => reading)
    const blocker = deferred<string>()
    let started = false
    const first = gate.admit(async () => {
      started = true
      const value = await blocker.promise
      return value
    })
    let ran = 0
    const second = gate.admit(async () => {
      ran++
      return 'b'
    })
    // Let the first read actually START (its check passed), then let pressure rise while the second read waits behind it.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(started, 'the front read started under the low reading')
    reading = HIGH
    blocker.resolve('a')
    assert.equal(await first, 'a', 'the running read settles normally')
    assert.equal(await second, undefined, 'the queued read meets the hot heap at its turn')
    assert.equal(ran, 0)
    // And pressure falling again admits the next read.
    reading = LOW
    assert.equal(await gate.admit(async () => 'c'), 'c')
  })

  test('the boundary is strict: exactly two-thirds full does not admit', async () => {
    const at = makeColdReadGate(() => ({ used: 200, limit: 300 }))
    assert.equal(await at.admit(async () => 'x'), undefined)
    const below = makeColdReadGate(() => ({ used: 199, limit: 300 }))
    assert.equal(await below.admit(async () => 'x'), 'x')
  })

  test('a hostile or garbage probe fails open', async () => {
    const throwing = makeColdReadGate(() => {
      throw new Error('hostile meter')
    })
    assert.equal(await throwing.admit(async () => 'x'), 'x')
    for (const junk of [
      { used: Number.NaN, limit: 1000 },
      { used: 100, limit: Number.NaN },
      { used: 100, limit: 0 },
      { used: 100, limit: -1 },
    ]) {
      const gate = makeColdReadGate(() => junk)
      assert.equal(await gate.admit(async () => 'x'), 'x', `junk reading ${JSON.stringify(junk)} admits`)
    }
  })

  test('a rejecting read propagates and the queue survives it', async () => {
    const gate = makeColdReadGate(() => LOW)
    const failure = gate.admit(async (): Promise<string> => {
      throw new Error('fold exploded')
    })
    await assert.rejects(failure, /fold exploded/)
    assert.equal(await gate.admit(async () => 'after'), 'after', 'the next read still runs')
  })

  test('the default reading is the process’s own V8 heap', async () => {
    const gate = makeColdReadGate()
    assert.equal(await gate.admit(async () => 'x'), 'x')
  })
})
