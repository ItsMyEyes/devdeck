import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBShowCreate } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBDDLView({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading, error } = useDBShowCreate(connectionId, object)
  const showToast = useDevDeckStore((s) => s.showToast)

  if (isLoading) return <DataLoading compact label="generating DDL…" />
  if (error || !data) {
    return <div className="p-4 text-[12px] text-devdeck-err">{error instanceof Error ? error.message : 'Failed to generate DDL'}</div>
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-fg-2">Generated DDL</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void navigator.clipboard.writeText(data.ddl); showToast('Copied DDL') }}
        >
          <Copy size={12} />
          Copy
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-devdeck-border-strong bg-devdeck-pane p-3 font-mono text-[11.5px] leading-relaxed text-devdeck-fg-2">
        {data.ddl}
      </pre>
    </div>
  )
}
