import { useDBStats } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'
import type { DBConnection } from '@/store/types'
import { DB_KIND_COLOR } from './dbColors'
import type { DBTabContent } from './dbTabs'

function formatBytes(n: number | null) {
  if (n === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] text-devdeck-dim">{label}</span>
      <span className="font-mono text-[11.5px] text-devdeck-fg-2">{value}</span>
    </div>
  )
}

/** Read-only estimated-size stats for a table/view/matview, reusing the same
 *  useDBStats hook DBTableGrid's inline DBTableInfo strip uses. Deliberately
 *  does NOT include the exact "Count rows" action — that needs the grid's
 *  current filter set, which lives as DBTableGrid's own local state and
 *  isn't available here; it stays in DBTableGrid's toolbar where it already
 *  works correctly against the active filters. */
function TableStats({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading } = useDBStats(connectionId, object)
  if (isLoading) return <span className="text-[11px] text-devdeck-dim">loading stats…</span>
  if (!data) return null
  return (
    <>
      <InspectorRow
        label="Est. rows"
        value={data.estRows === null ? '—' : `~${data.estRows.toLocaleString()}${data.analyzed ? '' : ' (unanalyzed)'}`}
      />
      <InspectorRow label="Total size" value={formatBytes(data.totalBytes)} />
      {data.indexBytes !== null ? <InspectorRow label="Index size" value={formatBytes(data.indexBytes)} /> : null}
    </>
  )
}

function kindColor(kind: string): string {
  if (kind === 'view') return DB_KIND_COLOR.view
  if (kind === 'matview') return DB_KIND_COLOR.matview
  if (kind === 'function') return DB_KIND_COLOR.function
  return DB_KIND_COLOR.table
}

export function DBInspectorPanel({ connection, activeTab }: { connection: DBConnection; activeTab: DBTabContent | null }) {
  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-devdeck-dim">
        Select an object to see its details here.
      </div>
    )
  }

  if (activeTab.kind === 'table') {
    return (
      <div className="p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wide" style={{ color: kindColor(activeTab.object.kind) }}>
          {activeTab.object.kind}
        </div>
        <div className="mb-3 truncate text-[13px] font-medium text-devdeck-fg">{activeTab.object.name}</div>
        <div className="divide-y divide-devdeck-border-menu/50">
          <TableStats connectionId={connection.id} object={activeTab.object} />
        </div>
      </div>
    )
  }

  if (activeTab.kind === 'ddl' || activeTab.kind === 'designer') {
    return (
      <div className="p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-devdeck-dim">
          {activeTab.kind === 'ddl' ? 'DDL' : 'Table designer'}
        </div>
        <div className="truncate text-[13px] font-medium text-devdeck-fg">{activeTab.object?.name ?? 'New table'}</div>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-devdeck-accent-soft">Query</div>
      <div className="mb-3 truncate text-[13px] font-medium text-devdeck-fg">{connection.name}</div>
      <div className="divide-y divide-devdeck-border-menu/50">
        <InspectorRow label="Engine" value={connection.engine} />
        <InspectorRow label="Database" value={connection.database} />
      </div>
    </div>
  )
}
