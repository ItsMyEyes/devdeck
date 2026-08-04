import { computeHighlight } from '@/lib/fuzzyHighlight'
import type { PaletteGroup, PaletteItem, RankedGroup, RankedItem } from '@/features/palette/paletteTypes'

export const MAX_ROWS_PER_GROUP = 8
export const MAX_ROWS_TOTAL = 50

/** Fixed render order. Create is last so it never displaces a real match. */
const GROUP_ORDER: PaletteGroup[] = ['open', 'recent', 'results', 'create']

const GROUP_LABEL: Record<PaletteGroup, string> = {
  open: 'Open tabs',
  recent: 'Recent',
  results: 'Results',
  create: 'Create',
}

/** Exact-prefix beats subsequence by a margin no frecency score can close,
 *  so typing the start of a name always surfaces that name first. */
const PREFIX_BONUS = 10_000
/** Beats any realistic frecency score but never an exact-prefix match — an
 *  entity that is currently open in another leaf outranks a merely-frecent
 *  one, per spec ranking rule 4. Distinct from `OPEN_BONUS` below: that one
 *  rewards the `open` *group* (the "Open tabs" bucket, which the fixed group
 *  order already renders above Results), this one rewards an *entity id*
 *  that also happens to be open, wherever it's currently being scored. */
const ALREADY_OPEN_BONUS = 5_000
const OPEN_BONUS = 1_000

/** The strict half of the matcher, and the *only* one `literalKeywords` gets:
 *  a long haystack such as a filesystem path contains almost any short query
 *  as a subsequence, so letting paths through `fuzzyMatches` would make every
 *  row match every query. */
function substringMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  return haystack.toLowerCase().includes(trimmed.toLowerCase())
}

/**
 * Substring match, then a subsequence-walk fallback — what `title` and
 * `keywords` are matched with.
 *
 * `computeHighlight` (see `@/lib/fuzzyHighlight`) never returns `null` — an
 * empty pattern and a genuine non-match both resolve to `[]`, because its
 * job is purely to pick which characters of an *already-matched* string to
 * emphasise, not to decide whether something matched. So match/no-match is
 * decided here, independently, with the same substring-then-subsequence
 * strategy; `computeHighlight` is then called only to derive display ranges
 * for a haystack that already passed this check.
 */
function fuzzyMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  if (substringMatches(haystack, trimmed)) return true
  const lowerHay = haystack.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  let cursor = 0
  for (const ch of lowerQuery) {
    const idx = lowerHay.indexOf(ch, cursor)
    if (idx < 0) return false
    cursor = idx + 1
  }
  return true
}

function scoreOne(
  item: PaletteItem,
  query: string,
  frecency: (id: string) => number,
  isOpen: (id: string) => boolean,
) {
  const fuzzyHay = [item.title, ...(item.keywords ?? [])]
  const literalHay = item.literalKeywords ?? []
  const matched =
    fuzzyHay.some((hay) => fuzzyMatches(hay, query)) || literalHay.some((hay) => substringMatches(hay, query))
  if (!matched) return null

  // Highlight ranges only make sense against the title, which is what the
  // row renders — a keyword-only match highlights nothing, and this is `[]`
  // whenever the title itself didn't match, since computeHighlight agrees.
  const ranges = computeHighlight(item.title, query)

  const lowerTitle = item.title.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let score = 0
  if (lowerQuery && lowerTitle.startsWith(lowerQuery)) score += PREFIX_BONUS
  if (isOpen(item.id)) score += ALREADY_OPEN_BONUS
  if (item.group === 'open') score += OPEN_BONUS
  score += frecency(item.id)
  // Shorter titles win ties: "prod" should beat "prod-db-replica-2".
  score += Math.max(0, 100 - item.title.length)

  return { ...item, score, ranges } satisfies RankedItem
}

/**
 * Filters, scores and groups items for display.
 *
 * The `create` group bypasses filtering entirely — its rows must stay
 * reachable no matter what is typed, because the query is frequently the
 * *name of the thing being created* and may well collide with an existing
 * entity (see the spec's Decision 2).
 */
export function rankPaletteItems(
  items: PaletteItem[],
  query: string,
  frecency: (id: string) => number,
  isOpen: (id: string) => boolean = () => false,
): RankedGroup[] {
  const buckets = new Map<PaletteGroup, RankedItem[]>()

  for (const item of items) {
    let ranked: RankedItem | null
    if (item.group === 'create') {
      ranked = { ...item, score: 0, ranges: [] }
    } else {
      ranked = scoreOne(item, query, frecency, isOpen)
    }
    if (!ranked) continue
    const bucket = buckets.get(item.group)
    if (bucket) bucket.push(ranked)
    else buckets.set(item.group, [ranked])
  }

  const groups: RankedGroup[] = []
  let budget = MAX_ROWS_TOTAL

  for (const group of GROUP_ORDER) {
    const bucket = buckets.get(group)
    if (!bucket || bucket.length === 0) continue
    if (group !== 'create') bucket.sort((a, b) => b.score - a.score)
    const cap = Math.min(MAX_ROWS_PER_GROUP, budget)
    const shown = bucket.slice(0, cap)
    budget -= shown.length
    groups.push({
      group,
      label: GROUP_LABEL[group],
      items: shown,
      truncated: bucket.length - shown.length,
    })
  }

  return groups
}

/** Row order as rendered — the basis for arrow-key selection. */
export function flattenRanked(groups: RankedGroup[]): RankedItem[] {
  return groups.flatMap((g) => g.items)
}
