import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_STASH_ENTRIES,
  STASH_STORAGE_KEY,
  addStashEntry,
  loadStash,
  removeStashEntryFrom,
  saveStash,
  stashEntrySnippet,
  takeStashEntryFrom,
} from '@/features/agent-chat/promptStash'
import type { PromptStashEntry } from '@/features/agent-chat/promptStash'

const NOW = '2026-08-15T12:00:00.000Z'
const now = () => NOW

function makeEntry(id: string, text = id): PromptStashEntry {
  return { id, createdAt: NOW, text }
}

describe('addStashEntry', () => {
  it('prepends the new entry as the newest', () => {
    const first = addStashEntry([], 'first', now)
    const second = addStashEntry(first.entries, 'second', now)
    expect(second.entries.map((e) => e.text)).toEqual(['second', 'first'])
  })

  it('assigns an id and the injected createdAt', () => {
    const { entries } = addStashEntry([], 'hello', now)
    expect(entries[0]?.text).toBe('hello')
    expect(entries[0]?.createdAt).toBe(NOW)
    expect(typeof entries[0]?.id).toBe('string')
    expect(entries[0]?.id.length).toBeGreaterThan(0)
  })

  it('does not mutate the input array', () => {
    const original: PromptStashEntry[] = [makeEntry('keep')]
    addStashEntry(original, 'new', now)
    expect(original).toEqual([makeEntry('keep')])
  })

  it('reports no eviction while under the cap', () => {
    let entries: PromptStashEntry[] = []
    for (let i = 0; i < MAX_STASH_ENTRIES; i++) {
      const result = addStashEntry(entries, `text-${i}`, now)
      expect(result.evicted).toBeNull()
      entries = result.entries
    }
    expect(entries).toHaveLength(MAX_STASH_ENTRIES)
  })

  it('evicts the oldest entry past the cap and returns it', () => {
    // Oldest is last: index 0 is newest, index MAX-1 is oldest.
    const existing = Array.from({ length: MAX_STASH_ENTRIES }, (_, i) => makeEntry(`entry-${i}`))
    const { entries, evicted } = addStashEntry(existing, 'overflow', now)
    expect(entries).toHaveLength(MAX_STASH_ENTRIES)
    expect(entries[0]?.text).toBe('overflow')
    expect(evicted?.id).toBe('entry-19')
    expect(entries.some((e) => e.id === 'entry-19')).toBe(false)
  })
})

describe('takeStashEntryFrom', () => {
  it('removes and returns the entry by id', () => {
    const entries = [makeEntry('keep'), makeEntry('take')]
    const result = takeStashEntryFrom(entries, 'take')
    expect(result.entry?.id).toBe('take')
    expect(result.entries.map((e) => e.id)).toEqual(['keep'])
  })

  it('does not mutate the input array', () => {
    const entries = [makeEntry('keep'), makeEntry('take')]
    takeStashEntryFrom(entries, 'take')
    expect(entries.map((e) => e.id)).toEqual(['keep', 'take'])
  })

  it('returns null and the same array reference for an unknown id', () => {
    const entries = [makeEntry('keep')]
    const result = takeStashEntryFrom(entries, 'missing')
    expect(result.entry).toBeNull()
    expect(result.entries).toBe(entries)
  })
})

describe('removeStashEntryFrom', () => {
  it('deletes the entry by id', () => {
    const entries = [makeEntry('keep'), makeEntry('drop')]
    expect(removeStashEntryFrom(entries, 'drop').map((e) => e.id)).toEqual(['keep'])
  })

  it('is a no-op for an unknown id', () => {
    const entries = [makeEntry('keep')]
    expect(removeStashEntryFrom(entries, 'missing')).toEqual(entries)
  })

  it('does not mutate the input array', () => {
    const entries = [makeEntry('keep'), makeEntry('drop')]
    removeStashEntryFrom(entries, 'drop')
    expect(entries.map((e) => e.id)).toEqual(['keep', 'drop'])
  })
})

describe('loadStash / saveStash', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage', () => {
    const entries = [makeEntry('a'), makeEntry('b')]
    expect(saveStash(entries)).toBe(true)
    expect(loadStash()).toEqual(entries)
  })

  it('returns [] when nothing is stored', () => {
    expect(loadStash()).toEqual([])
  })

  it('returns [] for malformed JSON', () => {
    localStorage.setItem(STASH_STORAGE_KEY, '{not json')
    expect(loadStash()).toEqual([])
  })

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem(STASH_STORAGE_KEY, JSON.stringify({ entries: [] }))
    expect(loadStash()).toEqual([])
  })

  it('returns [] when reading storage throws', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new DOMException('SecurityError')
    }
    expect(loadStash()).toEqual([])
    Storage.prototype.getItem = original
  })

  it('a failed write returns false and leaves storage untouched', () => {
    saveStash([makeEntry('before')])
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('QuotaExceededError')
    }
    const result = saveStash([makeEntry('before'), makeEntry('after')])
    Storage.prototype.setItem = original
    expect(result).toBe(false)
    // The prior successful write is what a caller would still see — the
    // failed write must not have landed even partially.
    expect(loadStash()).toEqual([makeEntry('before')])
  })
})

describe('stashEntrySnippet', () => {
  it('returns the trimmed text unchanged when short', () => {
    expect(stashEntrySnippet(makeEntry('a', '  hello world  '))).toBe('hello world')
  })

  it('collapses internal whitespace', () => {
    expect(stashEntrySnippet(makeEntry('a', 'hello\n\n  world\t!'))).toBe('hello world !')
  })

  it('truncates at 90 chars with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const snippet = stashEntrySnippet(makeEntry('a', long))
    expect(snippet).toBe(`${'x'.repeat(90)}…`)
    expect(snippet.length).toBe(91)
  })

  it('does not truncate text exactly at the limit', () => {
    const exact = 'x'.repeat(90)
    expect(stashEntrySnippet(makeEntry('a', exact))).toBe(exact)
  })

  it('returns (empty) for blank text', () => {
    expect(stashEntrySnippet(makeEntry('a', ''))).toBe('(empty)')
  })

  it('returns (empty) for whitespace-only text', () => {
    expect(stashEntrySnippet(makeEntry('a', '   \n\t  '))).toBe('(empty)')
  })
})
