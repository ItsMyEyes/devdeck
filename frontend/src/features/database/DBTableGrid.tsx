import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBColumns, useDBRows } from '@/features/data/queries'
import type { DBFilter, DBObjectRef, DBSortKey } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DBFilterBar } from './DBFilterBar'
import { DBTableInfo } from './DBTableInfo'

const ROW_HEIGHT = 30
const PAGE_LIMIT = 200

export function DBTableGrid({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data: columns, isLoading: columnsLoading, error: columnsError } = useDBColumns(connectionId, object)
  const [filters, setFilters] = useState<DBFilter[]>([])
  const [sort, setSort] = useState<DBSortKey[]>([])
  const [globalSearch, setGlobalSearch] = useState('')
  const [cursorStack, setCursorStack] = useState<(unknown[] | null)[]>([null])
  const pageIndex = cursorStack.length - 1

  const { data: page, isLoading: rowsLoading, error: rowsError } = useDBRows(connectionId, {
    object,
    filters,
    sort,
    cursor: cursorStack[pageIndex],
    offset: 0,
    limit: PAGE_LIMIT,
    globalSearch,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: page?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  function resetPaging() {
    setCursorStack([null])
  }

  function toggleSort(column: string) {
    setSort((prev) => {
      const existing = prev.find((s) => s.column === column)
      if (!existing) return [{ column, desc: false }]
      if (!existing.desc) return [{ column, desc: true }]
      return []
    })
    resetPaging()
  }

  function nextPage() {
    if (!page?.nextCursor) return
    setCursorStack((prev) => [...prev, page.nextCursor])
  }
  function prevPage() {
    setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  if (columnsLoading) return <DataLoading compact label="loading columns…" />
  if (columnsError || !columns) {
    return <div className="p-4 text-[12px] text-devdeck-red-soft">{columnsError instanceof Error ? columnsError.message : 'Failed to load columns'}</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DBFilterBar
        columns={columns}
        filters={filters}
        onFiltersChange={(f) => { setFilters(f); resetPaging() }}
        globalSearch={globalSearch}
        onGlobalSearchChange={(v) => { setGlobalSearch(v); resetPaging() }}
      />
      <div className="flex flex-none items-center justify-between border-b border-devdeck-border-menu px-3 py-1.5">
        <DBTableInfo connectionId={connectionId} object={object} />
        <div className="flex items-center gap-2 font-mono text-[11px] text-devdeck-dim">
          {page?.usedOffsetPaging ? <span className="text-devdeck-yellow-tint-text">offset paging — no usable row identity</span> : null}
          {page?.truncated ? <span>showing first {page.rows.length} rows</span> : null}
          <button type="button" onClick={prevPage} disabled={pageIndex === 0} className="disabled:opacity-30">
            ‹ prev
          </button>
          <button type="button" onClick={nextPage} disabled={!page?.nextCursor} className="disabled:opacity-30">
            next ›
          </button>
        </div>
      </div>

      {rowsError ? (
        <div className="p-4 text-[12px] text-devdeck-red-soft">{rowsError instanceof Error ? rowsError.message : 'Failed to load rows'}</div>
      ) : rowsLoading && !page ? (
        <DataLoading compact label="loading rows…" />
      ) : page && page.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-devdeck-dim">No rows match the current filters.</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex border-b border-devdeck-border-menu bg-devdeck-surface-2">
            {columns.map((col) => {
              const sortEntry = sort.find((s) => s.column === col.name)
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => toggleSort(col.name)}
                  style={{ minWidth: 140 }}
                  className="flex h-8 flex-1 items-center gap-1 border-r border-devdeck-border-menu px-2.5 text-left font-mono text-[11px] font-medium text-devdeck-muted hover:text-devdeck-fg"
                >
                  <span className="truncate">{col.name}</span>
                  {sortEntry ? <span className="text-devdeck-accent-soft">{sortEntry.desc ? '↓' : '↑'}</span> : null}
                </button>
              )
            })}
          </div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = page!.rows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  className={cn('flex border-b border-devdeck-border-menu/50', virtualRow.index % 2 === 1 && 'bg-white/[0.015]')}
                >
                  {columns.map((col, colIndex) => (
                    <div
                      key={col.name}
                      style={{ minWidth: 140 }}
                      className="flex flex-1 items-center truncate border-r border-devdeck-border-menu/50 px-2.5 font-mono text-[11.5px] text-devdeck-fg-2"
                    >
                      {col.isLob ? `⟨${String(row[colIndex])} bytes⟩` : row[colIndex] === null ? <span className="text-devdeck-dim-2 italic">null</span> : String(row[colIndex])}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
