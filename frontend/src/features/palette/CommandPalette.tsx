import { useEffect, useId, useRef } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { useCommandPalette } from '@/features/palette/useCommandPalette'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { HighlightRange } from '@/lib/fuzzyHighlight'
import type { RankedItem } from '@/features/palette/paletteTypes'

interface CommandPaletteProps {
  wsId: string
  /** The focused leaf, used when the palette was opened without one (the
   *  store records the leaf `Cmd+K` fired from). */
  leafId: string
}

/** Renders `text` with the given ranges emphasised — the same treatment
 *  `FileQuickOpen` gives its matches, from the same shared highlighter. */
function HighlightedText({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  if (ranges.length === 0) return <>{text}</>
  const nodes: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach(([start, end], i) => {
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(
      <span key={i} className="font-semibold text-devdeck-fg">
        {text.slice(start, end)}
      </span>,
    )
    cursor = end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <>{nodes}</>
}

/**
 * The global command palette (`Cmd/Ctrl+K`): one search-first surface over
 * open tabs, workspace entities, bookmarks, raw URLs and literal commands,
 * with an always-present Create group as the last resort.
 *
 * All the state lives in `useCommandPalette`; this file owns only the
 * overlay, the ghost-text composition and the keyboard contract.
 */
export function CommandPalette({ wsId, leafId }: CommandPaletteProps) {
  const open = useDevDeckStore((s) => s.palette.open && s.palette.wsId === wsId)
  const paletteLeafId = useDevDeckStore((s) => s.palette.leafId)
  // Same call `FileQuickOpen` makes: a native Browser-tile webview is stacked
  // above the entire app DOM, so no z-index alone can paint over one.
  useNativeOverlayBlocker(open)

  if (!open) return null
  return <CommandPaletteSurface wsId={wsId} leafId={paletteLeafId ?? leafId} />
}

function CommandPaletteSurface({ wsId, leafId }: { wsId: string; leafId: string }) {
  const closePalette = useDevDeckStore((s) => s.closePalette)
  const model = useCommandPalette({ wsId, leafId, open: true })
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const rowId = (id: string) => `${baseId}-row-${id}`

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keyboard-only navigation must never walk the selection out of view.
  useEffect(() => {
    const el = selectedRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [model.selectedIndex, model.rows])

  const selectedRow = model.rows[model.selectedIndex]

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
    if (event.key === 'ArrowDown' || (ctrl && event.key.toLowerCase() === 'n')) {
      event.preventDefault()
      model.moveSelection(1)
      return
    }
    if (event.key === 'ArrowUp' || (ctrl && event.key.toLowerCase() === 'p')) {
      // preventDefault also stops Ctrl+P reaching the global FileQuickOpen binding.
      event.preventDefault()
      model.moveSelection(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      model.run({ forceForm: event.shiftKey })
      return
    }
    if (event.key === 'Tab' || event.key === 'ArrowRight') {
      if (event.key === 'ArrowRight' && event.currentTarget.selectionStart !== model.query.length) return
      event.preventDefault()
      if (model.acceptCompletion()) return
      model.drillIn()
      return
    }
    if (event.key === 'Backspace' && model.query === '') {
      if (model.drillOut()) event.preventDefault()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!model.drillOut()) closePalette()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center bg-[rgba(8,9,10,0.62)] px-4 pt-[12vh]"
      onMouseDown={closePalette}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[68vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-devdeck-border-menu bg-devdeck-glass-solid shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-devdeck-border px-3">
          <Search size={15} className="flex-none text-devdeck-fg-2" />
          {model.breadcrumbs.map((crumb) => (
            <span
              key={crumb}
              className="flex flex-none items-center gap-1 rounded border border-devdeck-border-strong bg-devdeck-pane px-1.5 py-0.5 font-mono text-[10px] text-devdeck-fg-2"
            >
              {crumb}
              <ChevronRight size={10} className="text-devdeck-fg-2" />
            </span>
          ))}

          {/* The ghost is a sibling behind the input, never part of its value —
              so Enter can only ever submit what was actually typed. Both are
              monospace at the same size, so no text measurement is needed. */}
          <div className="relative min-w-0 flex-1">
            <span
              aria-hidden="true"
              data-testid="palette-ghost"
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center whitespace-pre font-mono text-[13px]"
            >
              <span className="invisible">{model.query}</span>
              <span className="text-devdeck-fg-2">{model.ghost}</span>
            </span>
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={model.rows.length > 0}
              aria-controls={listId}
              aria-activedescendant={selectedRow ? rowId(selectedRow.id) : undefined}
              aria-autocomplete="list"
              aria-label="Command palette search"
              value={model.query}
              onChange={(event) => model.setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={model.placeholder}
              className="relative w-full bg-transparent font-mono text-[13px] text-devdeck-fg outline-none placeholder:text-devdeck-fg-2"
            />
          </div>

          <span className="flex-none rounded border border-devdeck-border-strong bg-devdeck-pane px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
            ⌘K
          </span>
        </div>

        {model.sshPreview ? (
          <div className="flex flex-none items-center gap-2 border-b border-devdeck-border px-3 py-1.5 font-mono text-[11px]">
            <span className="text-devdeck-fg">{model.sshPreview.summary}</span>
            {model.sshPreview.ignored.length > 0 ? (
              <span className="text-devdeck-wait">{`· ignored: ${model.sshPreview.ignored.join(' ')}`}</span>
            ) : null}
          </div>
        ) : null}

        <div id={listId} role="listbox" aria-label="Palette results" className="min-h-0 flex-1 overflow-auto py-1.5">
          {model.rows.length === 0 ? (
            <div className="flex h-20 items-center justify-center font-mono text-[11px] text-devdeck-fg-2">
              No matches
            </div>
          ) : (
            model.groups.map((group) => (
              <div key={group.group}>
                <div className="flex items-center justify-between px-3 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-wide text-devdeck-fg-2">
                  <span>{group.label}</span>
                  {group.truncated > 0 ? <span>{`+${group.truncated} more`}</span> : null}
                </div>
                {group.items.map((item) => {
                  const index = model.rows.indexOf(item)
                  const selected = index === model.selectedIndex
                  return (
                    <PaletteRow
                      key={item.id}
                      ref={selected ? selectedRef : undefined}
                      id={rowId(item.id)}
                      item={item}
                      selected={selected}
                      onHover={() => model.setSelectedIndex(index)}
                      onActivate={() => model.run({ forceForm: false, index })}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex h-8 flex-none items-center gap-3 border-t border-devdeck-border bg-devdeck-pane px-3 font-mono text-[9.5px] text-devdeck-fg-2">
          <span>↑↓ select</span>
          <span>↵ run</span>
          <span>⇥ complete / drill in</span>
          <span>⌫ back</span>
          <span className="ml-auto">Esc close</span>
        </div>
      </div>
    </div>
  )
}

function PaletteRow({
  ref,
  id,
  item,
  selected,
  onHover,
  onActivate,
}: {
  ref?: React.Ref<HTMLDivElement>
  id: string
  item: RankedItem
  selected: boolean
  onHover: () => void
  onActivate: () => void
}) {
  const Icon = item.icon
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={item.disabled ? true : undefined}
      onMouseEnter={onHover}
      onClick={onActivate}
      className={cn(
        'flex h-9 w-full cursor-pointer items-center gap-2.5 px-3 text-left',
        selected ? 'bg-devdeck-on' : 'hover:bg-devdeck-hover-wash',
        item.disabled && 'opacity-45',
      )}
    >
      {Icon ? <Icon size={15} className="flex-none text-devdeck-fg-2" /> : <span className="w-[15px] flex-none" />}
      <span className="max-w-[58%] flex-none truncate font-mono text-[12px] text-devdeck-fg">
        <HighlightedText text={item.title} ranges={item.ranges} />
      </span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-devdeck-fg-2">
        {item.disabled ? item.disabled.reason : item.subtitle}
      </span>
    </div>
  )
}
