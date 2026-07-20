import { useEffect, useState } from 'react'
import { useCountDBRows, useDBStats } from '@/features/data/queries'
import type { DBFilter, DBObjectRef } from '@/lib/api'

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

export function DBTableInfo({ connectionId, object, filters }: { connectionId: string; object: DBObjectRef; filters: DBFilter[] }) {
  const { data, isLoading } = useDBStats(connectionId, object)
  const countMutation = useCountDBRows()
  const [exactCount, setExactCount] = useState<number | null>(null)

  // The exact count only reflects one specific filter set at the moment it
  // was fetched — once the object or filters change, it is not just stale,
  // it is a count of a different result set entirely, so it is cleared
  // rather than left displayed as if it still applied.
  useEffect(() => {
    setExactCount(null)
  }, [connectionId, object.database, object.schema, object.name, JSON.stringify(filters)])

  if (isLoading) return <span className="text-[11px] text-devdeck-dim">loading stats…</span>
  if (!data) return null

  function runCount() {
    countMutation.mutate(
      { connectionId, object, filters },
      { onSuccess: (result) => setExactCount(result.count) },
    )
  }

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-devdeck-dim">
      <span>
        {exactCount !== null
          ? `${exactCount.toLocaleString()} rows (exact)`
          : `~${data.estRows === null ? '—' : data.estRows.toLocaleString()} rows${data.analyzed ? '' : ' (unanalyzed)'}`}
      </span>
      <span>{formatBytes(data.totalBytes)} total</span>
      {data.indexBytes !== null ? <span>{formatBytes(data.indexBytes)} indexes</span> : null}
      {exactCount === null ? (
        <button
          type="button"
          onClick={runCount}
          disabled={countMutation.isPending}
          className="text-devdeck-accent-soft hover:text-devdeck-accent disabled:opacity-50"
          title="Runs a full COUNT(*) — a sequential scan on a large table, unlike the estimate above"
        >
          {countMutation.isPending ? 'counting…' : 'Count rows'}
        </button>
      ) : null}
    </div>
  )
}
