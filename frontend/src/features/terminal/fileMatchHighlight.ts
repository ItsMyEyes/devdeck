/**
 * Match-highlighting for the FileQuickOpen results list. Pure, presentational
 * logic — it does NOT reproduce the backend's ranking (backend/internal/
 * service/worktree_file.go `Search` decides which paths match and in what
 * order); it only decides which characters of an already-matched path to
 * emphasise, VS Code quick-open style. A purely-fuzzy match this simpler
 * matcher can't line up just renders without highlight, which is fine.
 *
 * No React here on purpose: the sibling fileMatchHighlight.test.ts runs under
 * `npx tsx` (this project has no Vitest/Jest — see fileTreeSelection.test.ts).
 */

/** A `[start, endExclusive)` slice of a string to emphasise. */
export type HighlightRange = [number, number]

// Mirrors looksLikeRegex() in worktree_file.go: when the operator is clearly
// typing a regex the backend matches by regex, and there's no meaningful
// per-character span to emphasise, so we skip highlighting entirely.
const REGEX_META = /[\^$*+?()[\]{}|]|\\\./

/**
 * Character ranges of `text` to emphasise for `query`, VS Code style. Splits
 * the query on whitespace and, per token, prefers contiguous case-insensitive
 * substring hits, falling back to an in-order (fuzzy) character match. Returns
 * sorted, non-overlapping ranges; an empty array means "render plainly".
 */
export function computeHighlight(text: string, query: string): HighlightRange[] {
  const trimmed = query.trim()
  if (trimmed === '' || text === '' || REGEX_META.test(trimmed)) return []
  const lowerText = text.toLowerCase()
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: HighlightRange[] = []
  for (const token of tokens) {
    if (!collectSubstringHits(lowerText, token, hits)) {
      collectSubsequenceHits(lowerText, token, hits)
    }
  }
  return mergeRanges(hits)
}

/** Push every case-insensitive substring occurrence of `token`; true if any. */
function collectSubstringHits(lowerText: string, token: string, out: HighlightRange[]): boolean {
  let found = false
  let from = 0
  for (;;) {
    const idx = lowerText.indexOf(token, from)
    if (idx < 0) break
    out.push([idx, idx + token.length])
    found = true
    from = idx + token.length
  }
  return found
}

/**
 * Greedy in-order character match (the fuzzy fallback). Only contributes spans
 * when every character of `token` is found in order — a partial match
 * emphasises nothing, so we never highlight a path the token doesn't cover.
 */
function collectSubsequenceHits(lowerText: string, token: string, out: HighlightRange[]): boolean {
  const indices: number[] = []
  let search = 0
  for (const ch of token) {
    const idx = lowerText.indexOf(ch, search)
    if (idx < 0) return false
    indices.push(idx)
    search = idx + 1
  }
  for (const idx of indices) out.push([idx, idx + 1])
  return true
}

/** Sort by start and merge overlapping/adjacent ranges into minimal spans. */
function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: HighlightRange[] = [[sorted[0][0], sorted[0][1]]]
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1]
    const [start, end] = sorted[i]
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }
  return merged
}
