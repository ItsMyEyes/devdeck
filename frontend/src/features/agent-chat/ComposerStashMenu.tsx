/**
 * Plan T8 — popover body listing the stashed prompts. Ported from t3code's
 * `ComposerStashMenu.tsx:32-176` (spec §6): keyboard-first, opened by ⌘S on
 * an empty composer, navigated with arrows, restored with Enter, deleted
 * with ⌘⌫/Ctrl+⌫ on the highlighted row, dismissed with Escape.
 *
 * All keyboard handling is bound **capture-phase on `window`**, not on a
 * local element, on mount — same reasoning t3code's own component uses
 * (`ComposerStashMenu.tsx:88-90`): the editor's own keymap (or, once T9
 * lands, `TabStripPopoverMenu`'s own focus trap) must not win while the menu
 * is logically open, and a window-level capture listener works regardless of
 * where focus actually sits at the moment the popover renders.
 *
 * This file owns list rendering and the keydown listener only — no popover
 * shell. T9 wraps this in `TabStripPopoverMenu` (T4's now-controllable
 * version) and supplies `entries` from the store's `promptStash`.
 */
import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Bookmark, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { stashEntrySnippet } from '@/features/agent-chat/promptStash'
import type { PromptStashEntry } from '@/features/agent-chat/promptStash'

export interface ComposerStashMenuProps {
  entries: PromptStashEntry[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function ComposerStashMenu({ entries, onSelect, onDelete, onClose }: ComposerStashMenuProps) {
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null)

  // Keeps the highlight valid across an external `entries` change (a row was
  // deleted, or a fresh entry was stashed while the menu stayed open) without
  // ever pointing at an id that no longer exists.
  useEffect(() => {
    if (entries.length === 0) {
      if (highlightedId !== null) setHighlightedId(null)
      return
    }
    if (!entries.some((entry) => entry.id === highlightedId)) {
      setHighlightedId(entries[0]?.id ?? null)
    }
  }, [entries, highlightedId])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (entries.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedId)
        const offset = event.key === 'ArrowDown' ? 1 : -1
        const base = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0
        const nextIndex = (base + offset + entries.length) % entries.length
        setHighlightedId(entries[nextIndex]?.id ?? null)
        return
      }

      if (event.key === 'Enter') {
        const highlighted = entries.find((entry) => entry.id === highlightedId)
        if (!highlighted) return
        event.preventDefault()
        event.stopPropagation()
        onSelect(highlighted.id)
        return
      }

      if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
        const highlighted = entries.find((entry) => entry.id === highlightedId)
        if (!highlighted) return
        event.preventDefault()
        event.stopPropagation()
        onDelete(highlighted.id)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [entries, highlightedId, onClose, onDelete, onSelect])

  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[14px]" role="listbox" aria-label="Stashed prompts">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-devdeck-fg-2 uppercase">
        <Bookmark className="size-3" aria-hidden="true" />
        Stashed prompts
      </div>
      {entries.length === 0 ? (
        <p className="px-3 pt-1 pb-3 text-xs text-devdeck-fg-2">
          Nothing stashed yet. Press ⌘S with a prompt in the composer to stash it.
        </p>
      ) : (
        <ul className="max-h-72 overflow-auto pb-1">
          {entries.map((entry) => {
            const highlighted = entry.id === highlightedId
            return (
              <li
                key={entry.id}
                data-testid={`composer-stash-entry-${entry.id}`}
                data-highlighted={highlighted ? 'true' : 'false'}
                role="option"
                aria-selected={highlighted}
                className={cn(
                  'group/stash flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left select-none',
                  highlighted
                    ? 'bg-devdeck-on text-devdeck-fg'
                    : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id)
                }}
                onClick={() => onSelect(entry.id)}
              >
                <Bookmark className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{stashEntrySnippet(entry)}</span>
                <span className="shrink-0 text-[11px] text-devdeck-fg-2">
                  {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                </span>
                <button
                  type="button"
                  aria-label="Delete stashed prompt"
                  className={cn(
                    'shrink-0 rounded-md p-1 opacity-0 transition-opacity',
                    'hover:bg-devdeck-red-tint hover:text-devdeck-err',
                    'group-hover/stash:opacity-100 focus-visible:opacity-100',
                  )}
                  onClick={(event) => {
                    // Do not also let the row's own onClick fire onSelect.
                    event.stopPropagation()
                    onDelete(entry.id)
                  }}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
