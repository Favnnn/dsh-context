import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { mapOf, squarify } from '../../src/client/treemap'
import type { Assembled } from '../../src/client/assemble'
import type { HeaderRecord, SurfaceNode } from '../../src/shared/types'
import { makeKit, surfaceNodeAt } from './helpers/kit'

const kit = makeKit()

function asm(over: Partial<Assembled>): Assembled {
  return { live: true, header: null, system: null, nodes: [], missingLive: 0, approximate: false, ...over }
}

function header(tools: { name: string; tokens: number }[]): HeaderRecord {
  return { seq: 1, time: 1000, systemTokens: 0, tools }
}

describe('mapOf grouping', () => {
  test('an empty view maps to no regions', () => {
    assert.deepEqual(mapOf(asm({}), kit.t, kit.catLabel), [])
  })

  test('the system prompt is a single block opening the sys row; a zero-token prompt drops out', () => {
    const cats = mapOf(asm({ system: { seq: 1, time: 1, tokens: 100 } }), kit.t, kit.catLabel)
    assert.deepEqual(cats, [{
      cat: 'system',
      tokens: 100,
      blocks: [{ key: 'sys', label: 'System Prompt', tokens: 100, count: 1, elem: 'sys' }],
    }])
    assert.deepEqual(mapOf(asm({ system: { seq: 1, time: 1, tokens: 0 } }), kit.t, kit.catLabel), [])
  })

  test('tool schemas keep one block each (zero-token schemas drop), sorted by size', () => {
    const cats = mapOf(asm({
      header: header([{ name: 'read', tokens: 20 }, { name: 'bash', tokens: 50 }, { name: 'noop', tokens: 0 }]),
    }), kit.t, kit.catLabel)
    assert.equal(cats.length, 1)
    assert.equal(cats[0].cat, 'tools')
    assert.equal(cats[0].tokens, 70)
    assert.deepEqual(cats[0].blocks.map(b => [b.key, b.label, b.tokens, b.elem]), [
      ['tools:bash', 'bash', 50, 'tool:bash'],
      ['tools:read', 'read', 20, 'tool:read'],
    ])
  })

  test('tool results fold by tool name: a multi-result group filters, a singleton opens its row', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(2, { cat: 'tool', tool: 'bash', tokens: 30 }),
      surfaceNodeAt(3, { cat: 'tool', tool: 'bash', tokens: 20 }),
      surfaceNodeAt(4, { cat: 'tool', tool: 'read', tokens: 10 }),
      surfaceNodeAt(5, { cat: 'tool', tokens: 5 }),
      surfaceNodeAt(6, { cat: 'tool', tool: 'zero', tokens: 0 }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.equal(cats.length, 1)
    assert.equal(cats[0].cat, 'tool')
    assert.equal(cats[0].tokens, 65)
    assert.deepEqual(cats[0].blocks, [
      { key: 'tool:bash', label: 'bash', tokens: 50, count: 2, query: 'bash' },
      { key: 'tool:read', label: 'read', tokens: 10, count: 1, elem: 'n4' },
      { key: 'tool:?', label: '?', tokens: 5, count: 1, elem: 'n5' },
    ])
  })

  test('skills group by skill name, falling back to the form label; injections group by form', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(1, { cat: 'skill', skill: 'code', tokens: 10 }),
      surfaceNodeAt(2, { cat: 'skill', skill: 'code', tokens: 5 }),
      surfaceNodeAt(3, { cat: 'skill', form: 'catalog', tokens: 7 }),
      surfaceNodeAt(7, { cat: 'skill', tokens: 3 }),
      surfaceNodeAt(4, { cat: 'inject', form: 'notice', tokens: 8 }),
      surfaceNodeAt(5, { cat: 'inject', form: 'notice', tokens: 4 }),
      surfaceNodeAt(6, { cat: 'inject', tokens: 6 }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => [c.cat, c.tokens]), [['inject', 18], ['skill', 25]])
    assert.deepEqual(cats[0].blocks, [
      { key: 'inject:notice', label: 'Notice', tokens: 12, count: 2, query: 'Notice' },
      { key: 'inject:context', label: 'Context Injection', tokens: 6, count: 1, elem: 'n6' },
    ])
    assert.deepEqual(cats[1].blocks, [
      { key: 'skill:code', label: 'code', tokens: 15, count: 2, query: 'code' },
      { key: 'skill~catalog', label: 'Catalog Update', tokens: 7, count: 1, elem: 'n3' },
      { key: 'skill~context', label: 'Context Injection', tokens: 3, count: 1, elem: 'n7' },
    ])
  })

  test('user and assistant messages stay solo: user labels by seq, assistant by its call breadcrumb', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(2, { tokens: 10 }),
      surfaceNodeAt(3, { tokens: 5 }),
      surfaceNodeAt(4, { cat: 'assistant', tokens: 20, calls: ['bash', 'write'] }),
      surfaceNodeAt(5, { cat: 'assistant', tokens: 8, text: 'done' }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => c.cat), ['user', 'assistant'])
    assert.deepEqual(cats[0].blocks.map(b => [b.label, b.elem]), [
      ['#2', 'n2'],
      ['#3', 'n3'],
    ])
    assert.deepEqual(cats[1].blocks.map(b => [b.label, b.elem]), [
      ['bash › write', 'n4'],
      ['#5', 'n5'],
    ])
  })

  test('regions keep the canonical category order and their tokens equal their blocks’ sum', () => {
    const cats = mapOf(asm({
      system: { seq: 1, time: 1, tokens: 100 },
      header: header([{ name: 'bash', tokens: 50 }]),
      nodes: [
        surfaceNodeAt(2, { tokens: 10 }),
        surfaceNodeAt(3, { cat: 'assistant', tokens: 30 }),
        surfaceNodeAt(4, { cat: 'tool', tool: 'bash', tokens: 40 }),
      ],
    }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => c.cat), ['system', 'tools', 'user', 'assistant', 'tool'])
    for (const c of cats) {
      assert.equal(c.tokens, c.blocks.reduce((acc, b) => acc + b.tokens, 0))
    }
  })

  test('a category past the fold cap keeps its top blocks and folds the tail into one “more” block', () => {
    const nodes: SurfaceNode[] = Array.from({ length: 13 }, (_, i) => surfaceNodeAt(i + 1, { tokens: 100 - i }))
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    const blocks = cats[0].blocks
    assert.equal(blocks.length, 12)
    assert.deepEqual(blocks.map(b => b.label), [
      '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '2 more',
    ])
    const rest = blocks[11]
    assert.equal(rest.tokens, 89 + 88, 'the fold sums the tail')
    assert.equal(rest.count, 2)
    assert.equal(rest.elem, undefined)
    assert.equal(rest.query, undefined)
  })

  test('exactly at the cap no fold happens', () => {
    const nodes: SurfaceNode[] = Array.from({ length: 12 }, (_, i) => surfaceNodeAt(i + 1, { tokens: 10 + i }))
    const blocks = mapOf(asm({ nodes }), kit.t, kit.catLabel)[0].blocks
    assert.equal(blocks.length, 12)
    assert.ok(blocks.every(b => b.elem !== undefined))
  })
})

describe('squarify', () => {
  const sized = (tokens: number, tag = ''): { tokens: number; tag: string } => ({ tokens, tag })

  test('empty input, an all-zero list, and a degenerate box all lay out to nothing', () => {
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 100, h: 100 }), [])
    assert.deepEqual(squarify([sized(0), sized(0)], { x: 0, y: 0, w: 100, h: 100 }), [])
    assert.deepEqual(squarify([sized(10)], { x: 0, y: 0, w: 0, h: 100 }), [])
    assert.deepEqual(squarify([sized(10)], { x: 0, y: 0, w: 100, h: 0 }), [])
  })

  test('a single item fills the box; zero-token neighbors drop without a gap', () => {
    assert.deepEqual(squarify([sized(10, 'a'), sized(0)], { x: 5, y: 6, w: 100, h: 50 }), [
      { item: { tokens: 10, tag: 'a' }, rect: { x: 5, y: 6, w: 100, h: 50 } }],
    )
  })

  test('two equal items in a square share one vertical strip', () => {
    const out = squarify([sized(50, 'a'), sized(50, 'b')], { x: 0, y: 0, w: 100, h: 100 })
    assert.deepEqual(out.map(o => o.rect), [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 },
    ])
  })

  test('items tile the box exactly, biggest first, without overlap or overflow', () => {
    for (const box of [{ x: 0, y: 0, w: 640, h: 240 }, { x: 10, y: 20, w: 100, h: 400 }]) {
      const items = [sized(4000, 'a'), sized(3000, 'b'), sized(2000, 'c'), sized(1000, 'd'), sized(500, 'e'), sized(250, 'f')]
      const out = squarify(items, box)
      assert.equal(out.length, items.length)
      assert.equal(out[0].item.tag, 'a', 'sorted biggest-first')
      let area = 0
      for (const o of out) {
        area += o.rect.w * o.rect.h
        assert.ok(o.rect.x >= box.x - 1e-6 && o.rect.y >= box.y - 1e-6)
        assert.ok(o.rect.x + o.rect.w <= box.x + box.w + 1e-3)
        assert.ok(o.rect.y + o.rect.h <= box.y + box.h + 1e-3)
        for (const p of out) {
          if (p === o) continue
          const overlap = Math.max(0, Math.min(o.rect.x + o.rect.w, p.rect.x + p.rect.w) - Math.max(o.rect.x, p.rect.x))
            * Math.max(0, Math.min(o.rect.y + o.rect.h, p.rect.y + p.rect.h) - Math.max(o.rect.y, p.rect.y))
          assert.ok(overlap < 1e-6, `no overlap: ${JSON.stringify(o.rect)} vs ${JSON.stringify(p.rect)}`)
        }
      }
      assert.ok(Math.abs(area - box.w * box.h) < 0.01, `area ${area} ≈ box ${box.w * box.h}`)
    }
  })

  test('a new strip starts when the next item would worsen the strip’s worst aspect ratio', () => {
    // 40/30/20/10 in a square: 20 breaks the first strip, 10 breaks the second (worked example from the algorithm).
    const out = squarify([sized(40, 'a'), sized(30, 'b'), sized(20, 'c'), sized(10, 'd')], { x: 0, y: 0, w: 100, h: 100 })
    assert.ok(Math.abs(out[0].rect.w - 70) < 1e-9 && Math.abs(out[0].rect.x) < 1e-9)
    assert.ok(Math.abs(out[1].rect.y - out[0].rect.h) < 1e-9, 'b stacks under a in the first strip')
    assert.ok(Math.abs(out[2].rect.x - 70) < 1e-9, 'c opens the second strip')
    assert.ok(Math.abs(out[3].rect.y - out[2].rect.h) < 1e-9 && Math.abs(out[3].rect.x - 70) < 1e-9, 'd sits under c')
  })
})
