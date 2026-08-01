import { describe, expect, it } from 'vitest'
import { computeHighlight } from '@/lib/fuzzyHighlight'

describe('computeHighlight', () => {
  it('returns an empty range list for an empty pattern', () => {
    expect(computeHighlight('prod-db', '')).toEqual([])
  })

  it('returns an empty range list when the pattern does not match', () => {
    expect(computeHighlight('prod-db', 'zzz')).toEqual([])
  })

  it('matches a contiguous prefix as one range', () => {
    expect(computeHighlight('prod-db', 'prod')).toEqual([[0, 4]])
  })

  it('matches a subsequence as multiple ranges', () => {
    // p(0), d(3), b(6) — each a single-char range; the unchanged algorithm
    // does not merge them since none are adjacent.
    expect(computeHighlight('prod-db', 'pdb')).toEqual([[0, 1], [3, 4], [6, 7]])
  })

  it('is case-insensitive', () => {
    expect(computeHighlight('Prod-DB', 'prod')).toEqual([[0, 4]])
  })
})
