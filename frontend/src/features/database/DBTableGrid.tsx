import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRightLeft, Plus, Trash2, Undo2, Upload, X } from 'lucide-react'
import { DataLoading } from '@/features/screens/DataLoading'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { useDBColumns, useDBRows } from '@/features/data/queries'
import type { DBFilter, DBObjectRef, DBRowEdit, DBSortKey } from '@/lib/api'
import { cn } from '@/lib/utils'
import { classifyDataType, DB_TYPE_BADGE } from './dbColors'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { DBExportMenu } from './DBExportMenu'
import { DBFilterBar } from './DBFilterBar'
import { DBImportWizard } from './DBImportWizard'
import { DBTableInfo } from './DBTableInfo'
import { DBTransferDialog } from './DBTransferDialog'

const ROW_HEIGHT = 30
const PAGE_LIMIT = 200
const IDENTITY_COL_WIDTH = 28

interface PendingInsert {
  id: string
  /** Only columns the operator actually typed into are present — an omitted
   *  column lets the database apply its own default rather than the frontend
   *  fabricating an empty-string value for it. */
  values: Record<string, string>
}

export function DBTableGrid({
  connectionId,
  object,
  onDirtyChange,
}: {
  connectionId: string
  object: DBObjectRef
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { data: columns, isLoading: columnsLoading, error: columnsError } = useDBColumns(connectionId, object)
  const [filters, setFilters] = useState<DBFilter[]>([])
  const [sort, setSort] = useState<DBSortKey[]>([])
  const [globalSearch, setGlobalSearch] = useState('')
  const [cursorStack, setCursorStack] = useState<(unknown[] | null)[]>([null])
  const pageIndex = cursorStack.length - 1
  const openCommitDialog = useDevDeckStore((s) => s.openCommitDialog)
  const [importOpen, setImportOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)

  const [pendingEdits, setPendingEdits] = useState<Map<string, unknown>>(new Map())
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(new Set())
  const [pendingInserts, setPendingInserts] = useState<PendingInsert[]>([])

  // Switching tables (or re-fetching after a schema change) invalidates every
  // row index and synthetic id the pending state above refers to.
  useEffect(() => {
    setPendingEdits(new Map())
    setPendingDeletes(new Set())
    setPendingInserts([])
    // The wizards are bound to one object; leaving them open across a switch
    // would let a mapping built for the old table run against the new one.
    setImportOpen(false)
    setTransferOpen(false)
  }, [connectionId, object.database, object.schema, object.name])

  function cellKey(rowIndex: number, column: string) {
    return `${rowIndex}:${column}`
  }

  function setPendingValue(rowIndex: number, column: string, value: string) {
    setPendingEdits((prev) => {
      const next = new Map(prev)
      next.set(cellKey(rowIndex, column), value)
      return next
    })
  }

  function toggleDelete(rowIndex: number) {
    setPendingDeletes((prev) => {
      const next = new Set(prev)
      if (next.has(rowIndex)) next.delete(rowIndex)
      else next.add(rowIndex)
      return next
    })
  }

  function addPendingRow() {
    setPendingInserts((prev) => [...prev, { id: `new-${Date.now()}-${prev.length}`, values: {} }])
  }

  function removePendingInsert(id: string) {
    setPendingInserts((prev) => prev.filter((r) => r.id !== id))
  }

  function setPendingInsertValue(id: string, column: string, value: string) {
    setPendingInserts((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const values = { ...r.values }
        if (value === '') delete values[column]
        else values[column] = value
        return { ...r, values }
      }),
    )
  }

  function discardAllPending() {
    setPendingEdits(new Map())
    setPendingDeletes(new Set())
    setPendingInserts([])
  }

  function buildRowEdits(): DBRowEdit[] {
    if (!page) return []
    const edits: DBRowEdit[] = []

    const byRow = new Map<number, Record<string, unknown>>()
    for (const [key, value] of pendingEdits) {
      const [rowIndexStr, column] = key.split(':')
      const rowIndex = Number(rowIndexStr)
      // A row marked for deletion ignores any cell edits made before the
      // delete was toggled — deleting wins, there is nothing left to update.
      if (pendingDeletes.has(rowIndex)) continue
      if (!byRow.has(rowIndex)) byRow.set(rowIndex, {})
      byRow.get(rowIndex)![column] = value
    }
    for (const [rowIndex, newValues] of byRow) {
      const oldValues: Record<string, unknown> = {}
      page.columns.forEach((col, i) => { oldValues[col.name] = page.rows[rowIndex][i] })
      edits.push({ object, kind: 'update', oldValues, newValues })
    }

    for (const rowIndex of pendingDeletes) {
      const oldValues: Record<string, unknown> = {}
      page.columns.forEach((col, i) => { oldValues[col.name] = page.rows[rowIndex][i] })
      edits.push({ object, kind: 'delete', oldValues })
    }

    for (const insert of pendingInserts) {
      if (Object.keys(insert.values).length === 0) continue // untouched blank row — nothing to insert
      edits.push({ object, kind: 'insert', newValues: insert.values })
    }

    return edits
  }

  const updatedRowCount = new Set(
    Array.from(pendingEdits.keys())
      .map((k) => Number(k.split(':')[0]))
      .filter((rowIndex) => !pendingDeletes.has(rowIndex)),
  ).size
  const filledInsertCount = pendingInserts.filter((r) => Object.keys(r.values).length > 0).length
  const pendingCount = updatedRowCount + pendingDeletes.size + filledInsertCount

  useEffect(() => {
    onDirtyChange?.(pendingCount > 0)
  }, [pendingCount, onDirtyChange])

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

  const showGrid = Boolean(page) && (page!.rows.length > 0 || pendingInserts.length > 0)

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
        <DBTableInfo connectionId={connectionId} object={object} filters={filters} />
        <div className="flex items-center gap-3 font-mono text-[11px] text-devdeck-dim">
          <button type="button" onClick={addPendingRow} className="flex items-center gap-1 hover:text-devdeck-fg">
            <Plus size={11} />
            Add row
          </button>
          <div className="flex items-center gap-0.5">
            <DBExportMenu connectionId={connectionId} object={object} filters={filters} sort={sort} />
            <Button variant="ghost" size="icon-sm" onClick={() => setImportOpen(true)} title="Import rows from a CSV file" aria-label="Import rows">
              <Upload size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTransferOpen(true)}
              title="Transfer this table to another connection"
              aria-label="Transfer table"
            >
              <ArrowRightLeft size={13} />
            </Button>
          </div>
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

      {pendingCount > 0 ? (
        <div className="flex flex-none items-center justify-between border-b border-devdeck-yellow-tint-border bg-devdeck-yellow-tint px-3 py-1.5">
          <span className="font-mono text-[11px] text-devdeck-yellow-tint-text">{pendingCount} pending change{pendingCount === 1 ? '' : 's'}</span>
          <div className="flex gap-2">
            <button type="button" onClick={discardAllPending} className="text-[11px] text-devdeck-dim hover:text-devdeck-fg">
              Discard
            </button>
            <button
              type="button"
              onClick={() => openCommitDialog(connectionId, buildRowEdits(), discardAllPending)}
              className="text-[11px] font-medium text-devdeck-accent-soft hover:text-devdeck-accent"
            >
              Review &amp; commit
            </button>
          </div>
        </div>
      ) : null}

      {rowsError ? (
        <div className="p-4 text-[12px] text-devdeck-red-soft">{rowsError instanceof Error ? rowsError.message : 'Failed to load rows'}</div>
      ) : rowsLoading && !page ? (
        <DataLoading compact label="loading rows…" />
      ) : !showGrid ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-devdeck-dim">No rows match the current filters.</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex border-b border-devdeck-border-menu bg-devdeck-surface-2">
            <div style={{ width: IDENTITY_COL_WIDTH }} className="flex-none border-r border-devdeck-border-menu" />
            {columns.map((col) => {
              const sortEntry = sort.find((s) => s.column === col.name)
              const badge = classifyDataType(col.dataType)
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => toggleSort(col.name)}
                  style={{ minWidth: 140 }}
                  className="flex h-8 flex-1 items-center gap-1.5 border-r border-devdeck-border-menu px-2.5 text-left font-mono text-[11px] font-medium text-devdeck-muted hover:text-devdeck-fg"
                >
                  {badge ? <Pill color={DB_TYPE_BADGE[badge].color}>{DB_TYPE_BADGE[badge].label}</Pill> : null}
                  <span className="truncate">{col.name}</span>
                  {sortEntry ? <span className="text-devdeck-accent-soft">{sortEntry.desc ? '↓' : '↑'}</span> : null}
                </button>
              )
            })}
          </div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = page!.rows[virtualRow.index]
              const isDeleted = pendingDeletes.has(virtualRow.index)
              return (
                <div
                  key={virtualRow.key}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  className={cn(
                    'flex border-b border-devdeck-border-menu/50',
                    virtualRow.index % 2 === 1 && 'bg-white/[0.015]',
                    isDeleted && 'bg-devdeck-red-tint/40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleDelete(virtualRow.index)}
                    style={{ width: IDENTITY_COL_WIDTH }}
                    className="flex flex-none items-center justify-center border-r border-devdeck-border-menu/50 text-devdeck-dim hover:text-devdeck-red-soft"
                    aria-label={isDeleted ? 'Restore row' : 'Delete row'}
                    title={isDeleted ? 'Restore row' : 'Delete row'}
                  >
                    {isDeleted ? <Undo2 size={11} /> : <Trash2 size={11} />}
                  </button>
                  {columns.map((col, colIndex) => {
                    const key = cellKey(virtualRow.index, col.name)
                    const isPending = pendingEdits.has(key)
                    const display = isPending ? String(pendingEdits.get(key)) : row[colIndex]
                    return col.isLob ? (
                      <div key={col.name} style={{ minWidth: 140 }} className="flex flex-1 items-center truncate border-r border-devdeck-border-menu/50 px-2.5 font-mono text-[11.5px] text-devdeck-fg-2">
                        ⟨{String(row[colIndex])} bytes⟩
                      </div>
                    ) : (
                      <input
                        key={col.name}
                        defaultValue={display === null ? '' : String(display)}
                        disabled={isDeleted}
                        onBlur={(e) => { if (e.target.value !== String(display ?? '')) setPendingValue(virtualRow.index, col.name, e.target.value) }}
                        style={{ minWidth: 140 }}
                        className={cn(
                          'flex-1 border-r border-devdeck-border-menu/50 bg-transparent px-2.5 font-mono text-[11.5px] text-devdeck-fg-2 outline-none focus:bg-devdeck-accent-tint/30 disabled:cursor-not-allowed',
                          isPending && !isDeleted && 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text',
                          isDeleted && 'text-devdeck-dim line-through',
                        )}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>

          {pendingInserts.map((insert) => (
            <div key={insert.id} className="flex border-b border-devdeck-border-menu/50 bg-devdeck-accent-tint/10">
              <button
                type="button"
                onClick={() => removePendingInsert(insert.id)}
                style={{ width: IDENTITY_COL_WIDTH }}
                className="flex flex-none items-center justify-center border-r border-devdeck-border-menu/50 text-devdeck-dim hover:text-devdeck-red-soft"
                aria-label="Remove new row"
                title="Remove new row"
              >
                <X size={11} />
              </button>
              {columns.map((col) => (
                <input
                  key={col.name}
                  defaultValue={insert.values[col.name] ?? ''}
                  disabled={col.isLob}
                  onChange={(e) => setPendingInsertValue(insert.id, col.name, e.target.value)}
                  placeholder={col.isLob ? '(not settable here)' : col.name}
                  style={{ minWidth: 140 }}
                  className="flex-1 border-r border-devdeck-border-menu/50 bg-transparent px-2.5 font-mono text-[11.5px] text-devdeck-accent-soft outline-none placeholder:text-devdeck-dim-2 focus:bg-devdeck-accent-tint/30 disabled:cursor-not-allowed"
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Mounted only while open: both dialogs fetch columns and hold a whole
          run's state, and a per-tab grid stays mounted when its tab is hidden. */}
      {importOpen ? (
        <DBImportWizard open={importOpen} onOpenChange={setImportOpen} connectionId={connectionId} object={object} />
      ) : null}
      {transferOpen ? (
        <DBTransferDialog open={transferOpen} onOpenChange={setTransferOpen} connectionId={connectionId} object={object} />
      ) : null}
    </div>
  )
}
