import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { cn } from '@/lib/utils'
import type { BlockCommand } from './blocks'

export interface SlashMenuHandle {
  /** Returns true when the key was consumed, which is what tells the
   *  suggestion plugin to stop the editor from also acting on it. */
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

/**
 * The "/" block-command popup. Mounted and positioned by
 * `@tiptap/suggestion`'s managed `mount()` (Floating UI under the hood), so
 * this component only draws the list and owns the highlight.
 */
export const SlashMenu = forwardRef<SlashMenuHandle, SuggestionProps<BlockCommand, BlockCommand>>(
  function SlashMenu({ items, command }, ref) {
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

    if (items.length === 0) return null

    return (
      <div
        ref={listRef}
        className="z-[70] flex max-h-72 w-72 flex-col overflow-y-auto rounded-sm bg-notion-surface p-1.5 font-[family-name:var(--nt-font)] shadow-[var(--nt-shadow)]"
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => command(item)}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1 text-left transition-colors',
              index === highlighted ? 'bg-notion-hover' : 'hover:bg-notion-hover',
            )}
          >
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-sm border border-notion-border text-notion-text">
              <item.icon size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[14px] text-notion-text-strong">{item.label}</span>
              <span className="truncate text-[11.5px] text-notion-text-dim">{item.hint}</span>
            </span>
          </button>
        ))}
      </div>
    )
  },
)
