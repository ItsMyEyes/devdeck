import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_EFFORT,
  MAX_COMPOSER_TURN_OPTIONS,
  clearTurnOptions,
  setTurnOptions,
} from '@/features/agent-chat/composerTurnOptions'
import type { ComposerTurnOptions } from '@/features/agent-chat/composerTurnOptions'

const NOW = 1_785_000_000_000
const MINUTE = 60_000

describe('setTurnOptions', () => {
  it('stores a non-default pick', () => {
    expect(setTurnOptions({}, 't1', { effort: 'low' }, NOW)).toEqual({ t1: { effort: 'low', updatedAt: NOW } })
  })

  // "Default" means "let the CLI decide" — nothing to remember.
  it('stores nothing for a pick that equals the default', () => {
    expect(setTurnOptions({}, 't1', { effort: DEFAULT_EFFORT }, NOW)).toEqual({})
    expect(setTurnOptions({}, 't1', { contextWindow: DEFAULT_CONTEXT_WINDOW }, NOW)).toEqual({})
  })

  it('merges a patch into the existing entry, field by field', () => {
    const once = setTurnOptions({}, 't1', { effort: 'max' }, NOW)
    const twice = setTurnOptions(once, 't1', { contextWindow: '1M' }, NOW + MINUTE)
    expect(twice).toEqual({ t1: { effort: 'max', contextWindow: '1M', updatedAt: NOW + MINUTE } })
  })

  it('drops a field that goes back to its default, and the entry once nothing is left', () => {
    const both = setTurnOptions(setTurnOptions({}, 't1', { effort: 'max' }, NOW), 't1', { contextWindow: '1M' }, NOW)
    const effortBack = setTurnOptions(both, 't1', { effort: DEFAULT_EFFORT }, NOW + MINUTE)
    expect(effortBack).toEqual({ t1: { contextWindow: '1M', updatedAt: NOW + MINUTE } })
    const allBack = setTurnOptions(effortBack, 't1', { contextWindow: DEFAULT_CONTEXT_WINDOW }, NOW + 2 * MINUTE)
    expect(allBack).toEqual({})
  })

  it('does not mutate the input map', () => {
    const original: Record<string, ComposerTurnOptions> = {}
    setTurnOptions(original, 't1', { effort: 'low' }, NOW)
    expect(original).toEqual({})
  })

  it('evicts the least-recently-updated entry past the cap', () => {
    let map: Record<string, ComposerTurnOptions> = {}
    for (let i = 0; i < MAX_COMPOSER_TURN_OPTIONS; i++) {
      map = setTurnOptions(map, `t${i}`, { effort: 'low' }, NOW + i * MINUTE)
    }
    expect(Object.keys(map)).toHaveLength(MAX_COMPOSER_TURN_OPTIONS)

    map = setTurnOptions(map, 'overflow', { effort: 'low' }, NOW + MAX_COMPOSER_TURN_OPTIONS * MINUTE)
    expect(Object.keys(map)).toHaveLength(MAX_COMPOSER_TURN_OPTIONS)
    expect(map.t0).toBeUndefined()
    expect(map.overflow).toBeDefined()
  })
})

describe('clearTurnOptions', () => {
  it('removes the key and returns the same reference when absent', () => {
    const map = setTurnOptions({}, 't1', { effort: 'low' }, NOW)
    expect(clearTurnOptions(map, 't1')).toEqual({})
    expect(clearTurnOptions(map, 'missing')).toBe(map)
  })
})
