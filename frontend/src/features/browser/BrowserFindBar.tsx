import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

export interface BrowserFindBarProps {
  open: boolean
  query: string
  onQueryChange: (value: string) => void
  active: number
  total: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

/** Spatially disjoint (design spec §3.0 technique 1): an inserted row
 *  between the toolbar and the page surface, not a floating overlay — it
 *  shrinks the page-surface wrapper's rect (and therefore the webview's own
 *  bounds) by its own height, the same mechanism the toolbar itself already
 *  uses to coexist with the live webview. Needs no occlusion blocker at
 *  all (§3.5) — it's never spatially on top of the webview to begin with. */
export function BrowserFindBar({ open, query, onQueryChange, active, total, onNext, onPrev, onClose }: BrowserFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  if (!open) return null

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrev()
      else onNext()
    }
  }

  return (
    <div className="flex h-8 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-bg px-2">
      <Search size={12} className="flex-none text-devdeck-dim" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find on page"
        className="min-w-0 flex-1 bg-transparent text-[11.5px] text-devdeck-fg outline-none placeholder:text-devdeck-dim"
      />
      <span className="flex-none text-[10.5px] text-devdeck-muted">{total > 0 ? `${active}/${total}` : ''}</span>
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous match"
        className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        onClick={onNext}
        aria-label="Next match"
        className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find bar"
        className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <X size={12} />
      </button>
    </div>
  )
}
