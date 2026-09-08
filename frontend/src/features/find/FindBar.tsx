import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DomFindController } from './useDomFind'

/**
 * The find bar for markdown surfaces — one component for all of them, matching
 * the terminal's search bar (Terminal.tsx) so the two read as the same feature.
 *
 * `data-find-skip` on the wrapper keeps the bar out of its own search: it is
 * rendered *inside* the container being searched on some surfaces, and without
 * this the query text in the input would count as a match against itself.
 */
export function FindBar({
  controller,
  className,
  label = 'Find in document',
}: {
  controller: DomFindController
  /** Positioning belongs to the caller — each surface has a different anchor. */
  className?: string
  label?: string
}) {
  const { query, setQuery, matchCount, activeIndex, next, previous, close, inputRef } = controller
  const hasQuery = query.length > 0

  return (
    <div
      data-find-skip
      role="search"
      aria-label={label}
      className={cn(
        'z-20 flex items-center gap-1 rounded-md border border-devdeck-border bg-devdeck-pane px-2 py-1 shadow-lg',
        className,
      )}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        // Escape is not handled here: `useDomFind` claims it across the whole
        // surface, so it also works from the next/previous buttons and from
        // the document the search just scrolled to.
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (event.shiftKey) previous()
          else next()
        }}
        placeholder="Find…"
        aria-label={label}
        className="w-40 bg-transparent font-mono text-[11px] text-devdeck-fg outline-none placeholder:text-devdeck-fg-2"
      />
      {/* Live so a screen reader hears the count change as the query is typed,
          which is the only feedback a non-sighted user gets from a highlight. */}
      <span aria-live="polite" className="min-w-[3.5rem] text-right font-mono text-[10.5px] text-devdeck-fg-2 tabular-nums">
        {!hasQuery ? '' : matchCount === 0 ? 'No results' : `${activeIndex + 1}/${matchCount}`}
      </span>
      <button
        type="button"
        onClick={previous}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous match (⇧Enter)"
        className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-default disabled:opacity-40"
      >
        <ChevronUp size={12} />
      </button>
      <button
        type="button"
        onClick={next}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next match (Enter)"
        className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-default disabled:opacity-40"
      >
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Close find"
        title="Close (Esc)"
        className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg"
      >
        <X size={12} />
      </button>
    </div>
  )
}
