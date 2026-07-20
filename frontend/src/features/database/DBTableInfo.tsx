import { useDBStats } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'

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

export function DBTableInfo({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading } = useDBStats(connectionId, object)
  if (isLoading) return <span className="text-[11px] text-devdeck-dim">loading stats…</span>
  if (!data) return null
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-devdeck-dim">
      <span>
        ~{data.estRows === null ? '—' : data.estRows.toLocaleString()} rows{data.analyzed ? '' : ' (unanalyzed)'}
      </span>
      <span>{formatBytes(data.totalBytes)} total</span>
      {data.indexBytes !== null ? <span>{formatBytes(data.indexBytes)} indexes</span> : null}
    </div>
  )
}
