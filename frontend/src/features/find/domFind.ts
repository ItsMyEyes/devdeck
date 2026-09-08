/**
 * Plain-text search over a rendered DOM subtree, returning `Range`s.
 *
 * This is what stands in for the browser's own find bar on the surfaces that
 * can't use it: DevDeck runs in a Tauri WKWebView with no chrome, so Cmd+F has
 * nothing to open, and inside the desktop shell there is no "find on page" at
 * all. Monaco and xterm each ship their own search; markdown views had none.
 *
 * Ranges rather than markup on purpose. Wrapping matches in `<mark>` would
 * mutate the DOM, and half these surfaces are a live ProseMirror
 * contenteditable — editing its DOM out from under it corrupts the document.
 * A `Range` is inert: `useDomFind` paints it through the CSS Custom Highlight
 * API, which is a paint-time overlay the document never sees.
 */

/** Text that is chrome rather than content, and must never match. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'])

/**
 * Tags that end a run of inline text.
 *
 * Text nodes are concatenated so a match can span inline formatting —
 * `find "hello world"` has to work across `hello **world**`, which is two text
 * nodes. Concatenating *everything* would go too far and match "foobar" across
 * the boundary of two adjacent paragraphs, so a separator is inserted whenever
 * the nearest block-level ancestor changes.
 *
 * A static tag list rather than `getComputedStyle().display`: the latter is a
 * layout read per text node on every keystroke, and returns nothing usable
 * under jsdom, where this module's tests run.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

/** One text node's slice of the flattened haystack. */
interface Piece {
  node: Text
  /** Index in the haystack where this node's own text begins. */
  start: number
  length: number
}

export interface FindTextOptions {
  caseSensitive?: boolean
  /**
   * Ceiling on returned matches. A one-character query over a long document
   * can produce tens of thousands of ranges, and every one of them is painted
   * — so the search stops rather than locking the frame.
   */
  limit?: number
}

export const DEFAULT_MATCH_LIMIT = 2000

function nearestBlock(node: Node, root: Node): Element | null {
  let current: Node | null = node.parentNode
  while (current && current !== root.parentNode) {
    if (current.nodeType === 1 && BLOCK_TAGS.has((current as Element).tagName)) return current as Element
    if (current === root) return current as Element
    current = current.parentNode
  }
  return null
}

function isSkipped(node: Text, root: Node): boolean {
  let current: Node | null = node.parentNode
  while (current && current !== root.parentNode) {
    if (current.nodeType === 1) {
      const element = current as Element
      if (SKIPPED_TAGS.has(element.tagName)) return true
      // `data-find-skip` is the opt-out for content that is rendered but isn't
      // part of the document — a placeholder, a gutter, a toolbar drawn inside
      // the searched container.
      if (element.hasAttribute('data-find-skip')) return true
      if (element.hasAttribute('hidden')) return true
      if (element.getAttribute('aria-hidden') === 'true') return true
    }
    current = current.parentNode
  }
  return false
}

/** The searchable text of `root`, plus the map back to its text nodes. */
function flatten(root: Node): { haystack: string; pieces: Piece[] } {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const pieces: Piece[] = []
  let haystack = ''
  let previousBlock: Element | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data || isSkipped(text, root)) continue

    const block = nearestBlock(text, root)
    // The separator occupies a haystack index that maps to no text node. That
    // is safe only because a query typed into a single-line input can never
    // contain "\n", so no match can straddle one — see `rangeFor`.
    if (previousBlock !== null && block !== previousBlock) haystack += '\n'
    previousBlock = block

    pieces.push({ node: text, start: haystack.length, length: text.data.length })
    haystack += text.data
  }

  return { haystack, pieces }
}

/** The piece containing haystack index `index`, by binary search. */
function pieceAt(pieces: Piece[], index: number): { piece: Piece; offset: number } | null {
  let low = 0
  let high = pieces.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const piece = pieces[mid]
    if (index < piece.start) high = mid - 1
    else if (index >= piece.start + piece.length) low = mid + 1
    else return { piece, offset: index - piece.start }
  }
  return null
}

function rangeFor(pieces: Piece[], start: number, end: number, doc: Document): Range | null {
  const from = pieceAt(pieces, start)
  // `end` is exclusive, so the last *included* character is at `end - 1`; its
  // piece is the one the range must end inside.
  const to = pieceAt(pieces, end - 1)
  if (!from || !to) return null
  const range = doc.createRange()
  range.setStart(from.piece.node, from.offset)
  range.setEnd(to.piece.node, to.offset + 1)
  return range
}

/**
 * Every occurrence of `query` in `root`'s rendered text, in document order.
 *
 * Returns `[]` for an empty or whitespace-only query rather than matching
 * everything — an empty find box means "no search running", not "select the
 * document".
 */
export function findTextRanges(root: Node | null, query: string, options: FindTextOptions = {}): Range[] {
  if (!root || !query) return []
  const doc = root.ownerDocument ?? (root as Document)
  if (!doc) return []

  const { haystack, pieces } = flatten(root)
  if (pieces.length === 0) return []

  const caseSensitive = options.caseSensitive ?? false
  const hay = caseSensitive ? haystack : haystack.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  if (!needle) return []

  const limit = options.limit ?? DEFAULT_MATCH_LIMIT
  const ranges: Range[] = []
  let from = 0
  while (ranges.length < limit) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    const range = rangeFor(pieces, at, at + needle.length, doc)
    if (range) ranges.push(range)
    // Overlapping matches are skipped: "aa" in "aaa" is one match, the way
    // every find bar behaves.
    from = at + needle.length
  }
  return ranges
}
