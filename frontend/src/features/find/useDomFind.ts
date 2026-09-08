import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { matchesBinding } from '@/features/keybindings/store'
import { findTextRanges } from './domFind'

/**
 * Highlight registry names. Two, not one: the active match has to read
 * differently from the rest, and `::highlight()` is styled per registered
 * name — see the `::highlight(devdeck-find*)` rules in globals.css.
 */
const HIGHLIGHT_ALL = 'devdeck-find'
const HIGHLIGHT_ACTIVE = 'devdeck-find-active'

/**
 * The CSS Custom Highlight API, or `null` where it isn't implemented.
 *
 * Chrome 105+/Safari 17.2+ have it, which covers the desktop shell on any
 * supported macOS, but DevDeck also runs in whatever browser the user points
 * at the hub. Without it the find bar still works — `applyHighlights` falls
 * back to putting the active match in the document selection, which shows the
 * same "here it is" with the platform's own selection colour.
 */
function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined') return null
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
  if (!registry || typeof Highlight === 'undefined') return null
  return registry
}

export interface DomFindController {
  open: boolean
  query: string
  setQuery: (next: string) => void
  /** Matches found for the current query. */
  matchCount: number
  /** 0-based position of the highlighted match, or -1 when there are none. */
  activeIndex: number
  next: () => void
  previous: () => void
  openFind: () => void
  close: () => void
  /** Attach to the find input so opening the bar focuses it. */
  inputRef: RefObject<HTMLInputElement | null>
}

export interface UseDomFindOptions {
  /**
   * Bumped by the caller when the searched content changes, so a live document
   * doesn't keep painting ranges into text that has moved. Any value works —
   * it is only ever compared for identity.
   */
  revision?: unknown
  /** Set false to leave the chord alone — a hidden tab, a disabled surface. */
  enabled?: boolean
  /**
   * Container the Cmd+F chord is claimed inside. Defaults to `rootRef`: the
   * two differ when the bar should also open from chrome that sits outside the
   * searched text (a toolbar above the document).
   */
  scopeRef?: RefObject<HTMLElement | null>
}

/**
 * Find-in-page for one DOM subtree: the chord, the match list, the navigation,
 * and the highlight painting.
 *
 * The caller owns the bar's markup (`FindBar`) and where it sits, because the
 * three surfaces using this each have a different place to put it.
 */
export function useDomFind(
  rootRef: RefObject<HTMLElement | null>,
  options: UseDomFindOptions = {},
): DomFindController {
  const { revision, enabled = true, scopeRef } = options
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Recomputed whenever the query, the revision or the open state changes. */
  const [generation, setGeneration] = useState(0)

  const matches = useMemo(() => {
    if (!open || !query) return []
    return findTextRanges(rootRef.current, query)
    // `generation` and `revision` are the "the DOM may have moved" signals;
    // ranges are computed from live nodes, so they are inputs even though
    // nothing reads their values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, generation, revision, rootRef])

  // A shorter query can leave the index past the end of the new match list.
  const clampedIndex = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1)

  // Content changed under a running search: recompute against the new DOM.
  useEffect(() => {
    if (!open) return
    setGeneration((n) => n + 1)
  }, [open, revision])

  // Paint. Runs after every match-list change and tears the highlights down on
  // unmount, so a closed find bar can never leave colour on the document.
  useEffect(() => {
    const registry = highlightRegistry()
    if (!registry) {
      // No highlight API: show the active match through the document selection
      // instead. Only the active one — selecting all matches is not something
      // a single selection can express.
      const active = clampedIndex >= 0 ? matches[clampedIndex] : null
      if (!active) return
      const selection = window.getSelection?.()
      if (!selection) return
      selection.removeAllRanges()
      selection.addRange(active)
      return
    }

    if (matches.length === 0) {
      registry.delete(HIGHLIGHT_ALL)
      registry.delete(HIGHLIGHT_ACTIVE)
      return
    }
    registry.set(HIGHLIGHT_ALL, new Highlight(...matches))
    const active = clampedIndex >= 0 ? matches[clampedIndex] : null
    if (active) registry.set(HIGHLIGHT_ACTIVE, new Highlight(active))
    else registry.delete(HIGHLIGHT_ACTIVE)

    return () => {
      registry.delete(HIGHLIGHT_ALL)
      registry.delete(HIGHLIGHT_ACTIVE)
    }
  }, [matches, clampedIndex])

  // Scroll the active match into view. Separate from painting so re-running the
  // paint (a revision bump, say) can't yank the page around on its own.
  useEffect(() => {
    if (clampedIndex < 0) return
    const range = matches[clampedIndex]
    const anchor = range.startContainer.parentElement
    // `nearest` rather than `center`: a match already on screen shouldn't move
    // the page at all, which is how a find bar is expected to behave when the
    // user is stepping through matches in one paragraph.
    anchor?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [matches, clampedIndex])

  const openFind = useCallback(() => {
    setOpen(true)
    setActiveIndex(0)
    setGeneration((n) => n + 1)
    // The bar may be mounting this very tick, so focus after paint.
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setActiveIndex(0)
    // Focus would otherwise fall to <body> as the bar unmounts — and every
    // chord in this feature is scoped by `contains`, so the next Cmd+F would
    // find nothing to match against and the bar could not be reopened from the
    // keyboard at all.
    rootRef.current?.focus?.({ preventScroll: true })
  }, [rootRef])

  const next = useCallback(() => {
    setActiveIndex((index) => (matches.length === 0 ? 0 : (index + 1) % matches.length))
  }, [matches.length])

  const previous = useCallback(() => {
    setActiveIndex((index) => (matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length))
  }, [matches.length])

  // The chord. Scoped by `contains` the same way Terminal.tsx scopes its own
  // find: several of these can be mounted at once across split panes, and only
  // the one holding focus may answer.
  useEffect(() => {
    if (!enabled) return
    function handleKeydown(event: KeyboardEvent) {
      if (!matchesBinding(event, 'document.find')) return
      const scope = (scopeRef ?? rootRef).current
      if (!scope || !scope.contains(event.target as Node)) return
      event.preventDefault()
      openFind()
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [enabled, openFind, rootRef, scopeRef])

  // Escape, from anywhere in the surface — not just from the input.
  //
  // Binding it on the input alone (the first cut here) meant that stepping
  // through matches with the next/previous buttons moved focus onto a button
  // and left Escape dead, and that Escape never worked at all while reading
  // the document the search had just scrolled to. Both are exactly when a
  // user reaches for it.
  useEffect(() => {
    if (!open) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const scope = (scopeRef ?? rootRef).current
      if (!scope || !scope.contains(event.target as Node)) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, close, rootRef, scopeRef])

  const setQueryAndReset = useCallback((next_: string) => {
    setQuery(next_)
    setActiveIndex(0)
  }, [])

  return {
    open,
    query,
    setQuery: setQueryAndReset,
    matchCount: matches.length,
    activeIndex: clampedIndex,
    next,
    previous,
    openFind,
    close,
    inputRef,
  }
}
