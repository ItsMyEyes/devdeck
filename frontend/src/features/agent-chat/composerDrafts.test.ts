import { describe, expect, it } from 'vitest'
import { MAX_COMPOSER_DRAFTS, clearDraft, setDraft } from '@/features/agent-chat/composerDrafts'
import type { ComposerDraft } from '@/features/agent-chat/composerDrafts'

const NOW = 1_785_000_000_000
const MINUTE = 60_000

describe('setDraft', () => {
  it('sets a new entry', () => {
    expect(setDraft({}, 'thread-1', 'hello', NOW)).toEqual({
      'thread-1': { text: 'hello', updatedAt: NOW },
    })
  })

  it('overwrites an existing entry for the same key', () => {
    const once = setDraft({}, 'thread-1', 'hello', NOW)
    const twice = setDraft(once, 'thread-1', 'hello world', NOW + MINUTE)
    expect(twice).toEqual({ 'thread-1': { text: 'hello world', updatedAt: NOW + MINUTE } })
  })

  it('does not mutate the input map', () => {
    const original: Record<string, ComposerDraft> = {}
    setDraft(original, 'thread-1', 'hello', NOW)
    expect(original).toEqual({})
  })

  it('deletes the key when text is empty', () => {
    const withDraft = setDraft({}, 'thread-1', 'hello', NOW)
    const cleared = setDraft(withDraft, 'thread-1', '', NOW + MINUTE)
    expect(cleared).toEqual({})
  })

  it('deletes the key when text is whitespace-only', () => {
    const withDraft = setDraft({}, 'thread-1', 'hello', NOW)
    const cleared = setDraft(withDraft, 'thread-1', '   \n\t  ', NOW + MINUTE)
    expect(cleared).toEqual({})
  })

  it('setting empty text on a key with no existing draft is a no-op', () => {
    expect(setDraft({}, 'thread-1', '', NOW)).toEqual({})
  })

  it('evicts the least-recently-updated entry past MAX_COMPOSER_DRAFTS', () => {
    let map: Record<string, ComposerDraft> = {}
    for (let i = 0; i < MAX_COMPOSER_DRAFTS; i++) {
      map = setDraft(map, `thread-${i}`, `text-${i}`, NOW + i * MINUTE)
    }
    expect(Object.keys(map)).toHaveLength(MAX_COMPOSER_DRAFTS)

    map = setDraft(map, 'newcomer', 'fresh text', NOW + MAX_COMPOSER_DRAFTS * MINUTE)

    expect(Object.keys(map)).toHaveLength(MAX_COMPOSER_DRAFTS)
    expect(map['thread-0']).toBeUndefined()
    expect(map.newcomer).toEqual({ text: 'fresh text', updatedAt: NOW + MAX_COMPOSER_DRAFTS * MINUTE })
  })

  it('eviction picks the oldest updatedAt, not insertion order', () => {
    let map: Record<string, ComposerDraft> = {}
    for (let i = 0; i < MAX_COMPOSER_DRAFTS; i++) {
      map = setDraft(map, `thread-${i}`, `text-${i}`, NOW + i * MINUTE)
    }
    // Touch thread-0 so it is no longer the oldest; thread-1 becomes the
    // least-recently-updated entry instead.
    map = setDraft(map, 'thread-0', 'refreshed', NOW + MAX_COMPOSER_DRAFTS * MINUTE)

    map = setDraft(map, 'newcomer', 'fresh text', NOW + (MAX_COMPOSER_DRAFTS + 1) * MINUTE)

    expect(Object.keys(map)).toHaveLength(MAX_COMPOSER_DRAFTS)
    expect(map['thread-0']).toBeDefined()
    expect(map['thread-1']).toBeUndefined()
    expect(map.newcomer).toBeDefined()
  })
})

describe('clearDraft', () => {
  it('removes the key', () => {
    const withDraft = setDraft({}, 'thread-1', 'hello', NOW)
    expect(clearDraft(withDraft, 'thread-1')).toEqual({})
  })

  it('is a no-op for an unknown key', () => {
    const withDraft = setDraft({}, 'thread-1', 'hello', NOW)
    expect(clearDraft(withDraft, 'thread-2')).toEqual(withDraft)
  })

  it('does not mutate the input map', () => {
    const withDraft = setDraft({}, 'thread-1', 'hello', NOW)
    clearDraft(withDraft, 'thread-1')
    expect(withDraft).toEqual({ 'thread-1': { text: 'hello', updatedAt: NOW } })
  })

  it('leaves other keys untouched', () => {
    let map = setDraft({}, 'thread-1', 'hello', NOW)
    map = setDraft(map, 'thread-2', 'world', NOW + MINUTE)
    expect(clearDraft(map, 'thread-1')).toEqual({ 'thread-2': { text: 'world', updatedAt: NOW + MINUTE } })
  })
})
