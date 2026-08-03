import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Search, Star } from 'lucide-react'
import { Select } from '@/components/ui/select'
import { StatusDot } from '@/components/ui/status-dot'
import { cn } from '@/lib/utils'
import type { MachineHealth } from '@/lib/api'
import type { Machine } from '@/store/types'
import { BrowserFaviconChip } from './BrowserFaviconChip'
import { splitUrlForDisplay } from './splitUrlForDisplay'

export interface BrowserOmniboxProps {
  /** Seeds the favicon chip — the active doc's id. */
  docId: string
  url: string
  title: string
  machineId: string
  machines: Machine[]
  machineHealth: Map<string, MachineHealth | undefined>
  onSelectMachine: (machineId: string) => void
  /** Whether the address is being edited *in the bar itself*. Owned by the
   *  parent because Cmd/Ctrl+L has to turn it on from outside this component.
   *  A tab with no URL always edits inline regardless of this flag — it has no
   *  address to display in the first place. */
  editing: boolean
  /** Raised by the URL area (never the machine chip or the star), by Escape,
   *  and by the input losing focus. Escape also rolls the draft back to the
   *  live URL; blur deliberately does not, so a draft survives a detour to the
   *  machine picker. */
  onEditingChange: (editing: boolean) => void
  /** Opens `BookmarkDialog`. The star lives here rather than in the toolbar's
   *  right cluster because it acts on the *address*, not the window. */
  onBookmark: () => void
  /** Draft address, owned by the parent and reset per doc. */
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (value: string) => void
  /** Put the caret in the inline input. Only the focused tile may pass true,
   *  or a background tile would steal the caret the moment it mounts. */
  autoFocus?: boolean
  /** Changing this value re-focuses the inline input — how Cmd/Ctrl+L reaches
   *  it without the parent holding a ref into this component. */
  focusSignal?: number
}

function dotColor(status: MachineHealth['status'] | undefined): string {
  if (status === 'online') return 'var(--devdeck-green)'
  if (status === 'offline') return 'var(--devdeck-red)'
  return 'var(--devdeck-dim)'
}

/** The toolbar's center zone and its anchor (design spec §3.3). Replaces both
 *  the old centered single-tab pill and the 112px machine `Select` that used
 *  to dominate the right cluster. */
export function BrowserOmnibox({
  docId,
  url,
  title,
  machineId,
  machines,
  machineHealth,
  onSelectMachine,
  editing,
  onEditingChange,
  onBookmark,
  draft,
  onDraftChange,
  onSubmit,
  autoFocus = false,
  focusSignal = 0,
}: BrowserOmniboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // The address is edited in the bar itself, the way every desktop browser
  // does it — not in a floating card. A tab with no URL is always in this
  // state: it has no page to name, and the two-tier URL button would otherwise
  // fall back to the literal string "New Tab" at full contrast,
  // indistinguishable from a real domain.
  const editingInline = editing || !url
  const { prefix, domain, rest } = splitUrlForDisplay(url)

  useEffect(() => {
    if (!editingInline) return
    // `autoFocus` is the mount-time guard that stops a *background* tile from
    // stealing the caret; `editing` is an explicit action on this tile, so it
    // takes the caret either way. `select()` rather than `focus()` so a draft
    // carried over from a failed navigation is replaced by the next keystroke.
    if (editing || autoFocus) inputRef.current?.select()
  }, [editingInline, editing, autoFocus, docId, focusSignal])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = draft.trim()
    if (value) onSubmit(value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape') return
    // Stops here rather than bubbling to the tile: Escape in the address bar
    // means "undo this edit", not whatever else the tile binds it to.
    event.stopPropagation()
    onDraftChange(url)
    onEditingChange(false)
  }
  const options = machines.map((m) => ({
    value: m.id,
    label: m.name,
    disabled: machineHealth.get(m.id)?.status === 'offline',
  }))
  const machineName = machines.find((m) => m.id === machineId)?.name ?? 'No machine'

  return (
    <div
      className={cn(
        'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border bg-devdeck-surface-2 pl-2 pr-1',
        'border-devdeck-border-card transition-colors',
        'hover:border-devdeck-border-strong focus-within:border-devdeck-border-strong',
        'max-w-[640px] pointer-coarse:h-9',
      )}
    >
      {editingInline ? (
        <>
          <Search size={12} className="flex-none text-devdeck-dim" />
          <form onSubmit={handleSubmit} className="flex min-w-0 flex-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              // Leaving the bar drops the editing state but keeps the draft —
              // clicking the machine picker mid-edit is a normal thing to do
              // and must not throw away what was typed. An empty tab has no
              // address to fall back to, so it just stays inline.
              onBlur={() => onEditingChange(false)}
              placeholder="Search or enter address"
              aria-label="Address"
              type="text"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              // 16px on coarse pointers: anything smaller makes iOS Safari zoom
              // the whole tile on focus.
              className={cn(
                'min-w-0 flex-1 bg-transparent text-[11px] text-devdeck-fg',
                'placeholder:text-devdeck-dim focus:outline-none pointer-coarse:text-[16px]',
              )}
            />
          </form>
        </>
      ) : (
        <>
          <BrowserFaviconChip seed={docId} title={title} size={14} />
          {/* Sibling of the Select trigger, never its ancestor — nesting two
              interactive elements is invalid HTML and overlaps their hit areas. */}
          <button
            type="button"
            onClick={() => onEditingChange(true)}
            aria-label="Edit address"
            className="flex min-w-0 flex-1 items-center text-left text-[11px] focus-visible:outline-none pointer-coarse:text-[13px]"
          >
            <span className="flex-none text-devdeck-dim">{prefix}</span>
            <span className="flex-none font-medium text-devdeck-fg">{domain}</span>
            <span className="min-w-0 truncate text-devdeck-dim">{rest}</span>
          </button>
        </>
      )}
      <span aria-hidden className="h-3 w-px flex-none bg-devdeck-border" />
      <Select
        value={machineId}
        onValueChange={onSelectMachine}
        options={options}
        chevronSize={10}
        aria-label={`Machine: ${machineName}`}
        triggerClassName={cn(
          'h-5 w-auto min-w-0 flex-none gap-1 rounded-full border-none bg-transparent px-1.5',
          'text-[10.5px] hover:bg-devdeck-hover-wash pointer-coarse:h-7',
        )}
        renderValue={(option) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot color={dotColor(machineHealth.get(machineId)?.status)} size={6} />
            <span className="hidden max-w-[72px] truncate @sm/tile:inline">{option?.label ?? 'No machine'}</span>
          </span>
        )}
      />
      <button
        type="button"
        onClick={onBookmark}
        disabled={!url}
        aria-label="Bookmark this page"
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center rounded-full text-devdeck-dim transition-colors',
          'hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2 disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 pointer-coarse:h-7 pointer-coarse:w-7',
        )}
      >
        <Star size={11} />
      </button>
    </div>
  )
}
