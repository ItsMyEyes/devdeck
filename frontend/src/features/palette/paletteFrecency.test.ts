import { beforeEach, describe, expect, it } from 'vitest'
import {
  FRECENCY_CAP,
  frecencyScore,
  loadFrecency,
  pruneFrecency,
  recordUse,
  saveFrecency,
} from '@/features/palette/paletteFrecency'
import type { FrecencyMap } from '@/features/palette/paletteFrecency'

const NOW = 1_785_000_000_000
const DAY = 86_400_000

describe('recordUse', () => {
  it('creates an entry on first use', () => {
    expect(recordUse({}, 'a', NOW)).toEqual({ a: { hits: 1, lastUsedAt: NOW } })
  })

  it('increments hits and moves the timestamp forward', () => {
    const once = recordUse({}, 'a', NOW)
    expect(recordUse(once, 'a', NOW + DAY)).toEqual({ a: { hits: 2, lastUsedAt: NOW + DAY } })
  })

  it('does not mutate the input map', () => {
    const original: FrecencyMap = {}
    recordUse(original, 'a', NOW)
    expect(original).toEqual({})
  })

  it('evicts the least recently used entry past the cap', () => {
    let map: FrecencyMap = {}
    for (let i = 0; i < FRECENCY_CAP; i++) map = recordUse(map, `id-${i}`, NOW + i)
    map = recordUse(map, 'newcomer', NOW + FRECENCY_CAP)
    expect(Object.keys(map)).toHaveLength(FRECENCY_CAP)
    expect(map['id-0']).toBeUndefined()
    expect(map.newcomer).toBeDefined()
  })
})

describe('frecencyScore', () => {
  it('is zero for an unknown id', () => {
    expect(frecencyScore({}, 'missing', NOW)).toBe(0)
  })

  it('decays with age', () => {
    const fresh: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW } }
    const stale: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW - 30 * DAY } }
    expect(frecencyScore(fresh, 'a', NOW)).toBeGreaterThan(frecencyScore(stale, 'a', NOW))
  })

  it('rewards repeated hits at equal age', () => {
    const once: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW } }
    const often: FrecencyMap = { a: { hits: 9, lastUsedAt: NOW } }
    expect(frecencyScore(often, 'a', NOW)).toBeGreaterThan(frecencyScore(once, 'a', NOW))
  })

  it('never returns a negative score', () => {
    const ancient: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW - 3650 * DAY } }
    expect(frecencyScore(ancient, 'a', NOW)).toBeGreaterThanOrEqual(0)
  })
})

describe('pruneFrecency', () => {
  it('drops ids that no longer resolve', () => {
    const map: FrecencyMap = { alive: { hits: 1, lastUsedAt: NOW }, dead: { hits: 5, lastUsedAt: NOW } }
    expect(pruneFrecency(map, new Set(['alive']))).toEqual({ alive: { hits: 1, lastUsedAt: NOW } })
  })

  it('returns the same reference when nothing is pruned', () => {
    const map: FrecencyMap = { alive: { hits: 1, lastUsedAt: NOW } }
    expect(pruneFrecency(map, new Set(['alive']))).toBe(map)
  })
})

describe('loadFrecency / saveFrecency', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage, scoped per workspace', () => {
    saveFrecency('ws1', { a: { hits: 3, lastUsedAt: NOW } })
    expect(loadFrecency('ws1')).toEqual({ a: { hits: 3, lastUsedAt: NOW } })
    expect(loadFrecency('ws2')).toEqual({})
  })

  it('returns an empty map for corrupt stored data', () => {
    localStorage.setItem('devdeck.palette.frecency.ws1', '{not json')
    expect(loadFrecency('ws1')).toEqual({})
  })

  it('returns an empty map when the stored value is not an object', () => {
    localStorage.setItem('devdeck.palette.frecency.ws1', '"a string"')
    expect(loadFrecency('ws1')).toEqual({})
  })

  it('does not throw when localStorage rejects a write', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('QuotaExceededError')
    }
    expect(() => saveFrecency('ws1', { a: { hits: 1, lastUsedAt: NOW } })).not.toThrow()
    Storage.prototype.setItem = original
  })
})
