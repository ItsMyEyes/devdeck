import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { DataLoading } from '@/features/screens/DataLoading'
import {
  useApplyDBDDL,
  useCommitDBEdits,
  useDBColumns,
  useDBConnections,
  useDBDDLPreview,
  useDBEngines,
  useFetchDBRowsPage,
} from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { buildTransferTablePlan } from './typeMap'
import { buildTransferEdits, lobColumnNames, nextPageRequest, rowsPerSecond } from './transfer'

const BATCH_OPTIONS = [
  { value: '500', label: '500 rows per page' },
  { value: '1000', label: '1000 rows per page' },
  { value: '5000', label: '5000 rows per page' },
]

interface Progress {
  running: boolean
  rows: number
  elapsedMs: number
  /** Set once the run ends for any reason; null while idle or running. */
  outcome: 'done' | 'cancelled' | 'error' | null
  error: string | null
  phase: string
}

const IDLE: Progress = { running: false, rows: 0, elapsedMs: 0, outcome: null, error: null, phase: '' }

export function DBTransferDialog({
  open,
  onOpenChange,
  connectionId,
  object,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  object: DBObjectRef
}) {
  const connections = useDBConnections().data ?? []
  const engines = useDBEngines().data
  const { data: sourceColumns, isLoading: columnsLoading, error: columnsError } = useDBColumns(connectionId, object, open)
  const previewDDL = useDBDDLPreview()
  const applyDDL = useApplyDBDDL()
  const fetchPage = useFetchDBRowsPage()
  const commit = useCommitDBEdits()
  const showToast = useDevDeckStore((s) => s.showToast)

  const sourceConnection = connections.find((c) => c.id === connectionId)

  const [targetConnectionId, setTargetConnectionId] = useState('')
  const [targetDatabase, setTargetDatabase] = useState('')
  const [targetSchema, setTargetSchema] = useState('public')
  const [targetTable, setTargetTable] = useState(object.name)
  const [createTarget, setCreateTarget] = useState(true)
  const [batchSize, setBatchSize] = useState('1000')
  const [statements, setStatements] = useState<string[] | null>(null)
  const [statementsOpen, setStatementsOpen] = useState(true)
  const [progress, setProgress] = useState<Progress>(IDLE)

  // The paging loop closes over its own render's state, so a cancel click made
  // after it starts is only observable through a ref.
  const cancelRequested = useRef(false)
  // Guards against a second start while the first is still awaiting a page —
  // `progress.running` is a render behind at the moment of the click.
  const startedRef = useRef(false)

  const targetConnection = connections.find((c) => c.id === targetConnectionId)
  const targetCaps = targetConnection ? engines?.[targetConnection.engine] : undefined
  const lobColumns = sourceColumns ? lobColumnNames(sourceColumns) : []

  // Reopening for a different table must not inherit the previous run's target
  // or progress; the effect keys on the dialog opening, not on every render.
  useEffect(() => {
    if (!open) return
    setTargetTable(object.name)
    setStatements(null)
    setProgress(IDLE)
    cancelRequested.current = false
    startedRef.current = false
  }, [open, object.name])

  // Default the target database to the chosen connection's own database — the
  // common case is "same database name, other server". Keyed on the id, not on
  // the connection object: a background refetch of the connections list would
  // otherwise re-run this and clobber a database the operator had typed.
  const targetDatabaseDefault = targetConnection?.database ?? ''
  useEffect(() => {
    setTargetDatabase(targetDatabaseDefault)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConnectionId])

  const running = progress.running
  const connectionOptions = connections.map((c) => ({
    value: c.id,
    label: `${c.name}${c.group ? ` · ${c.group}` : ''}${c.isProduction ? '  (production)' : ''}`,
  }))

  const targetObject: DBObjectRef = {
    database: targetDatabase.trim(),
    schema: targetCaps?.schemas ? targetSchema.trim() : '',
    name: targetTable.trim(),
    kind: 'table',
  }

  const canStart =
    !running &&
    Boolean(targetConnectionId) &&
    targetObject.name.length > 0 &&
    Boolean(sourceColumns) &&
    progress.outcome === null

  async function start() {
    if (!canStart || !sourceColumns || startedRef.current) return
    startedRef.current = true
    cancelRequested.current = false
    setStatements(null)
    setProgress({ ...IDLE, running: true, phase: 'preparing' })

    const startedAt = Date.now()
    let rows = 0

    // ---- 1. optionally create the target table ----
    if (createTarget) {
      const plan = buildTransferTablePlan(
        targetObject,
        sourceColumns,
        sourceConnection?.engine ?? '',
        targetConnection?.engine ?? '',
      )
      try {
        setProgress((p) => ({ ...p, phase: 'building CREATE TABLE' }))
        const preview = await previewDDL.mutateAsync({ connectionId: targetConnectionId, plan })
        setStatements(preview.statements)
        setProgress((p) => ({ ...p, phase: 'creating target table' }))
        await applyDDL.mutateAsync({ connectionId: targetConnectionId, plan })
      } catch (err) {
        startedRef.current = false
        setProgress({
          running: false,
          rows: 0,
          elapsedMs: Date.now() - startedAt,
          outcome: 'error',
          error: err instanceof Error ? err.message : 'Failed to create the target table',
          phase: '',
        })
        return
      }
    }

    // ---- 2. page through the source, committing each page to the target ----
    let cursor: unknown[] | null = null
    let usedOffsetPaging = false

    for (;;) {
      if (cancelRequested.current) {
        startedRef.current = false
        setProgress({ running: false, rows, elapsedMs: Date.now() - startedAt, outcome: 'cancelled', error: null, phase: '' })
        return
      }

      try {
        setProgress((p) => ({ ...p, phase: 'reading source' }))
        const page = await fetchPage.mutateAsync({
          connectionId,
          req: nextPageRequest(object, Number(batchSize), cursor, rows, usedOffsetPaging),
        })
        if (page.rows.length === 0) break

        setProgress((p) => ({ ...p, phase: 'writing target' }))
        await commit.mutateAsync({
          connectionId: targetConnectionId,
          edits: buildTransferEdits(targetObject, page.columns, page.rows),
        })

        rows += page.rows.length
        cursor = page.nextCursor
        usedOffsetPaging = page.usedOffsetPaging
        setProgress({ running: true, rows, elapsedMs: Date.now() - startedAt, outcome: null, error: null, phase: 'writing target' })

        // `truncated` is the driver's own "this page filled the limit" flag,
        // computed AFTER it clamps the requested limit to its 5000-row cap —
        // so a short page reads as exhausted here even if the server handed
        // back fewer rows than the page size asked for. Comparing
        // page.rows.length against batchSize would misread that clamp as the
        // end of the table.
        if (!page.truncated) break
        // A full page with no cursor under keyset paging would re-read page 1
        // forever; stop rather than duplicate the table into the target.
        if (!usedOffsetPaging && cursor === null) break
      } catch (err) {
        startedRef.current = false
        setProgress({
          running: false,
          rows,
          elapsedMs: Date.now() - startedAt,
          outcome: 'error',
          error: err instanceof Error ? err.message : 'Transfer failed',
          phase: '',
        })
        return
      }
    }

    startedRef.current = false
    setProgress({ running: false, rows, elapsedMs: Date.now() - startedAt, outcome: 'done', error: null, phase: '' })
    showToast(`Transferred ${rows} row${rows === 1 ? '' : 's'} to ${targetObject.name}`)
  }

  function close() {
    if (running) return
    onOpenChange(false)
  }

  const elapsedSeconds = progress.elapsedMs / 1000

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} width={620}>
      <div className="mb-3 flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <DialogTitle>Transfer {object.name}</DialogTitle>
          <DialogDescription className="mt-1">
            Reads this table page by page and inserts each page into another saved connection.
          </DialogDescription>
        </div>
        <button
          type="button"
          onClick={close}
          disabled={running}
          aria-label="Close"
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border border-devdeck-border-strong text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>

      {columnsLoading ? (
        <DataLoading compact label="loading columns…" />
      ) : columnsError || !sourceColumns ? (
        <div className="text-[12px] text-devdeck-red-soft">
          {columnsError instanceof Error ? columnsError.message : 'Failed to load source columns'}
        </div>
      ) : (
        <div className="max-h-[54vh] overflow-auto">
          <Label>Target connection</Label>
          <Select
            value={targetConnectionId}
            onValueChange={setTargetConnectionId}
            options={connectionOptions}
            disabled={running}
            aria-label="Target connection"
            className="mb-3"
          />

          <Label>Target database</Label>
          <Input
            value={targetDatabase}
            disabled={running}
            onChange={(e) => setTargetDatabase(e.target.value)}
            className="mb-3 font-mono"
          />

          {targetCaps?.schemas ? (
            <>
              <Label>Target schema</Label>
              <Input
                value={targetSchema}
                disabled={running}
                onChange={(e) => setTargetSchema(e.target.value)}
                className="mb-3 font-mono"
              />
            </>
          ) : null}

          <Label>Target table</Label>
          <Input
            value={targetTable}
            disabled={running}
            onChange={(e) => setTargetTable(e.target.value)}
            className="mb-3 font-mono"
          />

          <label className="mb-3 flex items-center gap-2 text-[12px] text-devdeck-fg">
            <input type="checkbox" checked={createTarget} disabled={running} onChange={(e) => setCreateTarget(e.target.checked)} />
            Create target table (types are mapped to the target engine; defaults are not carried over)
          </label>

          <Label>Page size</Label>
          <Select
            value={batchSize}
            onValueChange={setBatchSize}
            options={BATCH_OPTIONS}
            disabled={running}
            aria-label="Page size"
            className="mb-3"
          />

          {lobColumns.length > 0 ? (
            <p className="mb-3 flex items-start gap-1.5 text-[11.5px] text-devdeck-yellow-tint-text">
              <TriangleAlert size={12} className="mt-0.5 flex-none" />
              <span>
                Binary/large-object columns are not copied: <span className="font-mono">{lobColumns.join(', ')}</span>. The columns
                are still created in the target, but every value lands as the column's default or null.
              </span>
            </p>
          ) : null}

          {statements ? (
            <div className="mb-3 rounded-lg border border-devdeck-border-strong bg-devdeck-bg">
              <button
                type="button"
                onClick={() => setStatementsOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-devdeck-fg-2 hover:text-devdeck-fg"
              >
                {statementsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {statements.length} DDL statement{statements.length === 1 ? '' : 's'} applied to the target
              </button>
              {statementsOpen ? (
                <pre className="max-h-[150px] overflow-auto border-t border-devdeck-border-menu px-2.5 py-2 font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
                  {statements.join(';\n\n')};
                </pre>
              ) : null}
            </div>
          ) : null}

          {progress.running || progress.outcome !== null ? (
            <div className="rounded-lg border border-devdeck-border-card bg-devdeck-surface-2 p-2.5 font-mono text-[11px]">
              <div className="flex items-center gap-2 text-devdeck-fg-2">
                {progress.running ? <LoaderCircle size={12} className="animate-spin text-devdeck-accent-soft" /> : null}
                <span>{progress.rows} rows</span>
                <span className="text-devdeck-dim">·</span>
                <span>{elapsedSeconds.toFixed(1)}s</span>
                <span className="text-devdeck-dim">·</span>
                <span>{rowsPerSecond(progress.rows, progress.elapsedMs)} rows/s</span>
                {progress.running && progress.phase ? <span className="text-devdeck-dim">· {progress.phase}</span> : null}
              </div>
              {progress.outcome === 'error' ? (
                <div className="mt-1.5 text-devdeck-red-soft">
                  {progress.error} — {progress.rows} row{progress.rows === 1 ? '' : 's'} were already committed to the target and
                  remain there.
                </div>
              ) : progress.outcome === 'cancelled' ? (
                <div className="mt-1.5 text-devdeck-yellow-tint-text">
                  Cancelled after the in-flight page. {progress.rows} row{progress.rows === 1 ? '' : 's'} landed in the target and
                  remain there.
                </div>
              ) : progress.outcome === 'done' ? (
                <div className="mt-1.5 text-devdeck-green-soft">Transfer complete.</div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2.5">
        {running ? (
          <Button variant="destructive" onClick={() => { cancelRequested.current = true }}>
            Cancel after this page
          </Button>
        ) : null}
        <Button variant="secondary" onClick={close} disabled={running}>
          {progress.outcome !== null ? 'Close' : 'Cancel'}
        </Button>
        <Button
          onClick={() => void start()}
          disabled={!canStart || Boolean(columnsError) || !sourceColumns}
          className={cn(progress.outcome !== null && 'hidden')}
        >
          {running && <LoaderCircle size={14} className="animate-spin" />}
          Start transfer
        </Button>
      </div>
    </Dialog>
  )
}
