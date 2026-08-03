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

  // The cases below are ported verbatim from the pre-move
  // features/terminal/fileMatchHighlight.test.ts, whose `check()` harness was
  // dropped when the module moved here. They are the same inputs and the same
  // expected ranges — only the assertion syntax changed.

  it('highlights nothing for a whitespace-only query', () => {
    expect(computeHighlight('useScope.ts', '')).toEqual([])
    expect(computeHighlight('useScope.ts', '   ')).toEqual([])
  })

  it('highlights nothing when the text is empty', () => {
    expect(computeHighlight('', 'feature')).toEqual([])
  })

  it('highlights a substring match inside a basename', () => {
    expect(computeHighlight('useScope.ts', 'scope')).toEqual([[3, 8]])
  })

  it('highlights a substring match inside a folder path', () => {
    expect(computeHighlight('frontend/src/features', 'feature')).toEqual([[13, 20]])
  })

  it('matches case-insensitively against a capitalised basename', () => {
    expect(computeHighlight('Header.tsx', 'header')).toEqual([[0, 6]])
  })

  it('highlights every occurrence of a token', () => {
    // "s" appears at indices 9 (…/src…) and 20 (…feature[s]).
    expect(computeHighlight('frontend/src/features', 's')).toEqual([[9, 10], [20, 21]])
  })

  it('highlights each whitespace-separated token', () => {
    expect(computeHighlight('frontend/src/features/tabs', 'src tabs')).toEqual([[9, 12], [22, 26]])
  })

  it('falls back to a fuzzy subsequence and highlights the matched chars', () => {
    // "usc" is not a substring of "usescope.ts"; it matches u(0) s(1) c(4),
    // and the abutting u/s single-char hits merge into [0, 2].
    expect(computeHighlight('useScope.ts', 'usc')).toEqual([[0, 2], [4, 5]])
  })

  it('highlights nothing for an incomplete subsequence', () => {
    expect(computeHighlight('foo/bar.ts', 'xyz')).toEqual([])
  })

  it('skips highlighting entirely for a regex-looking query', () => {
    expect(computeHighlight('src/app.ts', 'app.*')).toEqual([])
  })

  it('merges adjacent hits into one span', () => {
    // Two tokens "fea" + "ture" both substring-hit and abut → single [13, 20].
    expect(computeHighlight('frontend/src/features', 'fea ture')).toEqual([[13, 20]])
  })
})
