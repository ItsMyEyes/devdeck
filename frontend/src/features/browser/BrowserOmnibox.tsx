import { Star } from 'lucide-react'
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
  /** Opens `BrowserUrlCard`. Fires from the URL area only, never from the
   *  machine chip or the star. */
  onEdit: () => void
  /** Opens `BookmarkDialog`. The star lives here rather than in the toolbar's
   *  right cluster because it acts on the *address*, not the window. */
  onBookmark: () => void
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
  onEdit,
  onBookmark,
}: BrowserOmniboxProps) {
  const { prefix, domain, rest } = splitUrlForDisplay(url)
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
      <BrowserFaviconChip seed={docId} title={title} size={14} />
      {/* Sibling of the Select trigger, never its ancestor — nesting two
          interactive elements is invalid HTML and overlaps their hit areas. */}
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit address"
        className="flex min-w-0 flex-1 items-center text-left text-[11px] focus-visible:outline-none pointer-coarse:text-[13px]"
      >
        <span className="flex-none text-devdeck-dim">{prefix}</span>
        <span className="flex-none font-medium text-devdeck-fg">{domain}</span>
        <span className="min-w-0 truncate text-devdeck-dim">{rest}</span>
      </button>
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
