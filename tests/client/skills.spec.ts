// The client skill catalog (src/client/skills.ts): the payload narrowing and the route read's never-reject
// contract (transport, status, envelope, and empty answers all read null), plus the clipboard seam behind the path footer.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { copySkillPath, readSkillCatalog, setSkillCopier, skillInfoListOf } from '../../src/client/skills'

afterEach(() => {
  setSkillCopier(null)
  vi.unstubAllGlobals()
})

describe('skillInfoListOf', () => {
  test('absent or malformed payloads read null', () => {
    assert.equal(skillInfoListOf(null), null)
    assert.equal(skillInfoListOf('x'), null)
    assert.equal(skillInfoListOf([]), null)
    assert.equal(skillInfoListOf({}), null)
    assert.equal(skillInfoListOf({ skills: 'nope' }), null)
  })

  test('entries failing the name proof drop individually; the proved fields ride alone', () => {
    assert.deepEqual(skillInfoListOf({
      skills: [
        null,
        'row',
        [],
        { description: 'no name' },
        { name: '' },
        { name: 42 },
        { name: 'bare' },
        { name: 'full', description: 'd', path: '/p/SKILL.md', source: 'bundled' },
        { name: 'odd', description: 7, path: '', source: '' },
      ],
    }), [
      { name: 'bare', description: '' },
      { name: 'full', description: 'd', path: '/p/SKILL.md', source: 'bundled' },
      { name: 'odd', description: '' },
    ])
  })
})

describe('readSkillCatalog', () => {
  function stubFetch(mode: 'ok' | 'reject' | 'status' | 'badjson', body?: unknown): { urls: string[]; bodies: unknown[] } {
    const urls: string[] = []
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url))
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
      if (mode === 'reject') throw new Error('down')
      if (mode === 'status') return { ok: false, json: async () => ({}) } as unknown as Response
      if (mode === 'badjson') return { ok: true, json: () => Promise.reject(new Error('not json')) } as unknown as Response
      return { ok: true, json: async () => body } as unknown as Response
    })
    return { urls, bodies }
  }

  test('a served catalog narrows into the name-keyed map; the cwd and session id ride the body', async () => {
    const { urls, bodies } = stubFetch('ok', {
      ok: true,
      value: {
        skills: [
          { name: 'tdd', description: 'Test-driven', path: '/p/tdd/SKILL.md', source: 'user-agents' },
          { name: 'ask-matt', description: 'A router' },
        ],
      },
    })
    const catalog = await readSkillCatalog('/repo/alpha', 's1')
    assert.deepEqual(urls, ['api/dsh-context/skills'])
    assert.deepEqual(bodies, [{ cwd: '/repo/alpha', sessionId: 's1' }])
    assert.equal(catalog?.size, 2)
    assert.deepEqual(catalog?.get('tdd'), { name: 'tdd', description: 'Test-driven', path: '/p/tdd/SKILL.md', source: 'user-agents' })
  })

  test('a context-less open posts an empty body', async () => {
    const { bodies } = stubFetch('ok', { ok: true, value: { skills: [{ name: 'tdd' }] } })
    await readSkillCatalog(undefined, undefined)
    assert.deepEqual(bodies, [{}])
  })

  test('every failure or empty answer reads null, never a rejection', async () => {
    stubFetch('reject')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('status')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('badjson')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', {})
    assert.equal(await readSkillCatalog(undefined, undefined), null, 'no ok flag')
    stubFetch('ok', { ok: false, value: { skills: [{ name: 'tdd' }] } })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', { ok: true, value: null })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', { ok: true, value: { skills: [] } })
    assert.equal(await readSkillCatalog(undefined, undefined), null, 'an empty catalog is no enrichment')
    stubFetch('ok', { ok: true, value: { skills: 'x' } })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
  })
})

describe('copySkillPath', () => {
  test('the seam’s write resolves true; a throwing write resolves false', async () => {
    const seen: string[] = []
    setSkillCopier(async (text) => { seen.push(text) })
    assert.equal(await copySkillPath('/p/tdd/SKILL.md'), true)
    assert.deepEqual(seen, ['/p/tdd/SKILL.md'])
    setSkillCopier(async () => { throw new Error('denied') })
    assert.equal(await copySkillPath('/p/tdd/SKILL.md'), false)
  })

  test('the default write rides the platform clipboard; an absent API fails the copy', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { written.push(text) } } })
    assert.equal(await copySkillPath('/p/a/SKILL.md'), true)
    assert.deepEqual(written, ['/p/a/SKILL.md'])
    vi.stubGlobal('navigator', {})
    assert.equal(await copySkillPath('/p/a/SKILL.md'), false)
    vi.stubGlobal('navigator', undefined)
    assert.equal(await copySkillPath('/p/a/SKILL.md'), false)
  })
})
