import { useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Braces, Download, FileCode, FileText, LoaderCircle } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { useExportDBTable } from '@/features/data/queries'
import type { DBExportFormat, DBFilter, DBObjectRef, DBSortKey } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const FORMATS: { value: DBExportFormat; label: string; hint: string; icon: typeof FileText }[] = [
  { value: 'csv', label: 'CSV', hint: 'RFC 4180, header row', icon: FileText },
  { value: 'json', label: 'JSON', hint: 'array of objects', icon: Braces },
  { value: 'sql', label: 'SQL', hint: 'INSERT statements', icon: FileCode },
]

/** Hands a Blob to the browser as a download. The object URL is revoked right
 *  after the synthetic click so a multi-hundred-megabyte export is not pinned
 *  in memory for the tab's lifetime. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Toolbar Export button: a popover of formats that streams the table through
 *  the server-side export endpoint using the grid's *current* filters and
 *  sort, so what downloads is what the operator is looking at. */
export function DBExportMenu({
  connectionId,
  object,
  filters,
  sort,
}: {
  connectionId: string
  object: DBObjectRef
  filters: DBFilter[]
  sort: DBSortKey[]
}) {
  const [open, setOpen] = useState(false)
  const exportTable = useExportDBTable()
  const showToast = useDevDeckStore((s) => s.showToast)
  const pending = exportTable.isPending

  async function run(format: DBExportFormat) {
    setOpen(false)
    try {
      const { blob, filename } = await exportTable.mutateAsync({
        connectionId,
        body: { object, filters, sort, format },
      })
      downloadBlob(blob, filename)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Export failed')
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
        title="Export this table (current filters and sort)"
        aria-label="Export table"
        disabled={pending}
      >
        {pending ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
          <Popover.Popup
            className={cn(
              'min-w-[190px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
              'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {FORMATS.map(({ value, label, hint, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => void run(value)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
              >
                <Icon size={12} className="flex-none text-devdeck-accent-soft" />
                {label}
                <span className="ml-auto text-[10px] text-devdeck-dim-2">{hint}</span>
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
