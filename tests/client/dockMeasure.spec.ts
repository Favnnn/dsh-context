// measureDock (src/client/dockMeasure.ts) — the /context modal's sidebar insets: the ancestor walk to the app
// frame's inline grid template and the leading/trailing px parses with the centre-minimum clamp.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { measureDock } from '../../src/client/dockMeasure'

/** A start element buried at the bottom of an ancestor chain (outermost first). */
function chainOf(...ancestors: HTMLElement[]): HTMLElement {
  for (let i = 0; i < ancestors.length - 1; i++) ancestors[i].appendChild(ancestors[i + 1])
  return ancestors[ancestors.length - 1]
}

function frameEl(template: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.gridTemplateColumns = template
  return el
}

afterEach(() => { vi.unstubAllGlobals() })

describe('measureDock', () => {
  test('resolves to the full mask without a start element', () => {
    assert.deepEqual(measureDock(null), { left: 0, right: 0, frame: null })
  })

  test('resolves to the full mask when no ancestor carries an inline template', () => {
    const start = chainOf(document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
  })

  test('parses the sidebar tracks off the frame ancestor (fixed right track)', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px minmax(0, 1fr) 360px')
    const start = chainOf(frame, document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 360, frame })
  })

  test('parses the minmax spelling: the right panel open and closed', () => {
    vi.stubGlobal('innerWidth', 1280)
    const openFrame = frameEl('280px minmax(400px, 1fr) minmax(0px, 576px)')
    assert.deepEqual(measureDock(chainOf(openFrame, document.createElement('div'))), { left: 280, right: 576, frame: openFrame })
    const closedFrame = frameEl('280px minmax(0px, 1fr) minmax(0px, 0px)')
    assert.deepEqual(measureDock(chainOf(closedFrame, document.createElement('div'))), { left: 280, right: 0, frame: closedFrame })
  })

  test('clamps the trailing bound to the space the centre minimum leaves (the grid squeeze)', () => {
    vi.stubGlobal('innerWidth', 1100)
    const frame = frameEl('280px minmax(400px, 1fr) minmax(0px, 576px)')
    assert.deepEqual(measureDock(chainOf(frame, document.createElement('div'))), { left: 280, right: 420, frame })

    // A centre minimum the viewport cannot serve degrades the right inset to nothing.
    vi.stubGlobal('innerWidth', 640)
    const starved = frameEl('280px minmax(400px, 1fr) minmax(0px, 360px)')
    assert.deepEqual(measureDock(chainOf(starved, document.createElement('div'))), { left: 280, right: 0, frame: starved })
  })

  test('parses a fractional track and a collapsed 0px rail', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('264.5px minmax(0, 1fr) 0px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 264.5, right: 0, frame })

    assert.deepEqual(measureDock(chainOf(frameEl('0px minmax(0, 1fr) 0px'), document.createElement('div'))).left, 0)
  })

  test('a centre track without a declared minimum leaves the whole remainder to the right panel', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px 1fr 360px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 360, frame })
  })

  test('a template of the leading track alone insets no right edge', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 0, frame })
  })

  test('resolves to the full mask when the frame template is unparsable', () => {
    for (const template of ['', 'minmax(0, 1fr)', 'auto 1fr', 'auto 1fr 360px']) {
      const start = chainOf(frameEl(template), document.createElement('div'))
      assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
    }
  })

  test('a hostile ancestor degrades to the full mask instead of throwing', () => {
    const hostile = document.createElement('div')
    Object.defineProperty(hostile, 'style', { get() { throw new Error('hostile') } })
    const start = chainOf(hostile, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
  })
})
