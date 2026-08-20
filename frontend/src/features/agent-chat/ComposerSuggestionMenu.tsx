/**
 * Plan D2 — the popup shared by all three composer suggestion triggers.
 * Extracted out of `composerMention.ts`'s private `MentionMenu` because D3
 * (`$` skills) and D4 (`/` commands) would otherwise each write it a third
 * time (design spec §2: "Extraction, not a third copy"). Same highlight
 * state, arrow-key/Enter/Tab handling and `scrollIntoView` behaviour as the
 * original, byte for byte — `composerMention.test.ts` staying green
 * unmodified is the proof this is an extraction, not a redesign.
 *
 * Generalized over `Item extends ComposerSuggestionMenuItem` and given two
 * new override branches the original never needed: `errorMessage` (a fetch
 * failure, not "no results") and `emptyMessage` (shown once loading has
 * finished and the result set is genuinely empty). Omitting `emptyMessage`
 * reproduces the file mention's original behavior — render nothing — so `@`
 * is unaffected by this extraction.
 */
import type { MouseEvent, ReactNode, RefAttributes } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { cn } from '@/lib/utils'

export interface ComposerSuggestionMenuItem {
  id: string
  label: string
  description?: string
  icon: LucideIcon
}

export interface ComposerSuggestionMenuProps<Item extends ComposerSuggestionMenuItem>
  extends SuggestionProps<Item, Item> {
  /** Stamped as `data-${itemTestAttr}` on each item button — e.g.
   *  'mention-item' -> `data-mention-item`, so each trigger keeps its own
   *  existing DOM-query contract after the extraction. */
  itemTestAttr: string
  /** A fetch failure, not "no results for this query" — overrides
   *  loading/empty entirely when non-null. */
  errorMessage?: string | null
  /** Shown when the (non-error) result set is empty and loading has
   *  finished. Omitted (undefined/null) reproduces the file mention's
   *  original behavior: render nothing. */
  emptyMessage?: string | null
}

export interface ComposerSuggestionMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

const STATUS_ROW = 'z-[70] w-72 rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-md'

function ComposerSuggestionMenuInner<Item extends ComposerSuggestionMenuItem>(
  { items, command, loading, itemTestAttr, errorMessage, emptyMessage }: ComposerSuggestionMenuProps<Item>,
  ref: React.ForwardedRef<ComposerSuggestionMenuHandle>,
): ReactNode {
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // A narrowing query can leave the highlight past the end of the list.
  useEffect(() => setHighlighted(0), [items])

  useEffect(() => {
    listRef.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (items.length === 0) return false
      if (event.key === 'ArrowDown') {
        setHighlighted((index) => (index + 1) % items.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setHighlighted((index) => (index - 1 + items.length) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        command(items[highlighted])
        return true
      }
      return false
    },
  }))

  if (errorMessage) {
    return <div className={cn(STATUS_ROW, 'text-destructive')}>{errorMessage}</div>
  }

  if (items.length === 0) {
    if (loading) return <div className={cn(STATUS_ROW, 'text-muted-foreground')}>Searching…</div>
    if (emptyMessage) return <div className={cn(STATUS_ROW, 'text-muted-foreground')}>{emptyMessage}</div>
    return null
  }

  return (
    <div
      ref={listRef}
      className="z-[70] flex max-h-72 w-72 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {items.map((item, index) => {
        const testAttr = { [`data-${itemTestAttr}`]: item.id }
        return (
          <button
            key={item.id}
            type="button"
            {...testAttr}
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => command(item)}
            className={cn(
              'flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1 text-left text-sm text-foreground',
              index === highlighted ? 'bg-muted' : 'hover:bg-muted',
            )}
          >
            <item.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{item.label}</span>
              {item.description ? (
                <span className="truncate text-xs text-muted-foreground">{item.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
ComposerSuggestionMenuInner.displayName = 'ComposerSuggestionMenu'

// forwardRef + a generic component don't compose directly in TSX — the cast
// is the standard workaround (React's own forwardRef types are non-generic).
export const ComposerSuggestionMenu = forwardRef(ComposerSuggestionMenuInner) as <
  Item extends ComposerSuggestionMenuItem,
>(
  props: ComposerSuggestionMenuProps<Item> & RefAttributes<ComposerSuggestionMenuHandle>,
) => ReactNode
