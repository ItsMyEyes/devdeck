import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, LoaderCircle, TriangleAlert, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { DataLoading } from '@/features/screens/DataLoading'
import { useCommitDBEdits, useDBColumns } from '@/features/data/queries'
import type { DBObjectRef, DBRowEdit } from '@/lib/api'
import { cn } from '@/lib/utils'
import { detectDelimiter, parseCSV, type CSVParseResult } from './csv'
import { autoMapColumns, buildInsertEdits, chunk, type ImportCellError } from './importMap'
import { buildPreviewRows, countRowsWithErrors, progressPercent, unmappedRequiredColumns } from './importWizard'

const STEPS = ['File', 'Mapping', 'Preview', 'Run'] as const
type StepIndex = 0 | 1 | 2 | 3

const PREVIEW_ROW_LIMIT = 10

const SKIP = '__skip__'
const AUTO = '__auto__'

const DELIMITER_OPTIONS = [
  { value: AUTO, label: 'Auto-detect' },
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab  \\t' },
  { value: '|', label: 'Pipe  |' },
]

const BATCH_OPTIONS = [
  { value: '100', label: '100 rows per batch' },
  { value: '500', label: '500 rows per batch' },
  { value: '1000', label: '1000 rows per batch' },
]

function delimiterLabel(d: string): string {
  return d === '\t' ? '\\t (tab)' : d
}

interface RunState {
  running: boolean
  done: number
  inserted: number
  /** 1-based index of the batch that failed, or null. */
  failedBatch: number | null
  error: string | null
  finished: boolean
  stopped: boolean
}

const IDLE_RUN: RunState = {
  running: false,
  done: 0,
  inserted: 0,
  failedBatch: null,
  error: null,
  finished: false,
  stopped: false,
}

export function DBImportWizard({
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
  const { data: columns, isLoading: columnsLoading, error: columnsError } = useDBColumns(connectionId, object, open)
  const commit = useCommitDBEdits()

  const [step, setStep] = useState<StepIndex>(0)
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState('')
  const [readError, setReadError] = useState<string | null>(null)
  const [delimiterChoice, setDelimiterChoice] = useState(AUTO)
  const [hasHeader, setHasHeader] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [batchSize, setBatchSize] = useState('500')
  const [run, setRun] = useState<RunState>(IDLE_RUN)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // A stop request has to be visible to the in-flight batch loop, which closes
  // over its own render's state — a ref is the only thing the loop can read
  // that reflects a click made after it started.
  const stopRequested = useRef(false)

  const delimiter = delimiterChoice === AUTO ? detectDelimiter(text) : delimiterChoice

  const parsed: CSVParseResult = useMemo(
    () => (text === '' ? { headers: [], rows: [], errors: [] } : parseCSV(text, { delimiter, hasHeader })),
    [text, delimiter, hasHeader],
  )

  const reset = useCallback(() => {
    setStep(0)
    setFileName('')
    setText('')
    setReadError(null)
    setDelimiterChoice(AUTO)
    setHasHeader(true)
    setMapping({})
    setRun(IDLE_RUN)
    stopRequested.current = false
  }, [])

  // Re-deriving the auto-mapping on every parse would discard the operator's
  // manual choices on an unrelated re-render, so it is seeded exactly once per
  // (headers, columns) pair.
  // JSON.stringify, not join(sep): every separator character is legal inside a
  // CSV header, so ["a,b"] and ["a","b"] would produce the same joined key and
  // a re-parse under a different delimiter would silently keep the old mapping.
  const headerKey = JSON.stringify(parsed.headers)
  useEffect(() => {
    if (!columns || parsed.headers.length === 0) return
    setMapping(autoMapColumns(parsed.headers, columns))
    // headerKey stands in for parsed.headers (a fresh array each parse).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKey, columns])

  function readFile(file: File) {
    setReadError(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onerror = () => setReadError(`Could not read ${file.name}`)
    reader.onload = () => setText(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  }

  const { edits, errors } = useMemo<{ edits: DBRowEdit[]; errors: ImportCellError[] }>(() => {
    if (!columns || parsed.headers.length === 0) return { edits: [], errors: [] }
    return buildInsertEdits(object, mapping, parsed.headers, parsed.rows, columns)
  }, [columns, object, mapping, parsed])

  const previewRows = useMemo(
    () => (columns ? buildPreviewRows(mapping, parsed.headers, parsed.rows, columns, PREVIEW_ROW_LIMIT) : []),
    [columns, mapping, parsed],
  )

  const missingRequired = columns ? unmappedRequiredColumns(mapping, parsed.headers, columns) : []
  const skippedRows = countRowsWithErrors(errors)
  const totalRows = parsed.rows.length

  // Memoized rather than re-chunked inline: the run step renders the batch
  // count in three places, and re-slicing a 100k-row edit list on every
  // progress tick would dominate the import's own cost.
  const batches = useMemo(() => chunk(edits, Number(batchSize)), [edits, batchSize])

  async function start() {
    if (run.running || edits.length === 0) return
    stopRequested.current = false
    setRun({ ...IDLE_RUN, running: true })

    let done = 0
    let inserted = 0

    for (let i = 0; i < batches.length; i += 1) {
      if (stopRequested.current) {
        setRun({ running: false, done, inserted, failedBatch: null, error: null, finished: true, stopped: true })
        return
      }
      try {
        const result = await commit.mutateAsync({ connectionId, edits: batches[i] })
        inserted += result.results.reduce((sum, r) => sum + r.rowsAffected, 0)
        done += batches[i].length
        setRun({ running: true, done, inserted, failedBatch: null, error: null, finished: false, stopped: false })
      } catch (err) {
        setRun({
          running: false,
          done,
          inserted,
          failedBatch: i + 1,
          error: err instanceof Error ? err.message : 'Batch failed',
          finished: true,
          stopped: false,
        })
        return
      }
    }

    setRun({ running: false, done, inserted, failedBatch: null, error: null, finished: true, stopped: false })
  }

  function close() {
    if (run.running) return
    onOpenChange(false)
    reset()
  }

  const canAdvance =
    step === 0 ? parsed.headers.length > 0 : step === 1 ? Object.values(mapping).some((v) => v !== null) : true

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} width={720}>
      <div className="mb-3 flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <DialogTitle>Import into {object.name}</DialogTitle>
          <DialogDescription className="mt-1">
            Rows are inserted through the same commit path as a manual edit — nothing is written until step 4.
          </DialogDescription>
        </div>
        <button
          type="button"
          onClick={close}
          disabled={run.running}
          aria-label="Close"
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border border-devdeck-border-strong text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>

      {/* step indicator */}
      <div className="mb-4 flex items-center gap-1.5">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <span
              className={cn(
                'flex h-5 w-5 flex-none items-center justify-center rounded-full border font-mono text-[10px]',
                i < step && 'border-devdeck-green-tint-border bg-devdeck-green-tint text-devdeck-green-soft',
                i === step && 'border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-accent-soft',
                i > step && 'border-devdeck-border-menu text-devdeck-dim-2',
              )}
            >
              {i < step ? <Check size={10} /> : i + 1}
            </span>
            <span className={cn('text-[11px]', i === step ? 'text-devdeck-fg' : 'text-devdeck-dim')}>{label}</span>
            {i < STEPS.length - 1 ? <div className="h-px flex-1 bg-devdeck-border-menu" /> : null}
          </div>
        ))}
      </div>

      {columnsLoading ? (
        <DataLoading compact label="loading columns…" />
      ) : columnsError || !columns ? (
        <div className="text-[12px] text-devdeck-red-soft">
          {columnsError instanceof Error ? columnsError.message : 'Failed to load target columns'}
        </div>
      ) : (
        <div className="max-h-[52vh] min-h-[220px] overflow-auto">
          {/* ---- step 1: file ---- */}
          {step === 0 ? (
            <div>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragActive(false)
                  const file = e.dataTransfer.files[0]
                  if (file) readFile(file)
                }}
                className={cn(
                  'mb-3 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 transition-colors',
                  dragActive
                    ? 'border-devdeck-border-accent bg-devdeck-accent-tint/40'
                    : 'border-devdeck-border-strong bg-devdeck-bg',
                )}
              >
                <Upload size={18} className="text-devdeck-dim" />
                <p className="text-[12px] text-devdeck-fg-2">Drop a .csv, .tsv or .txt file here</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) readFile(file)
                    // Clear the value so re-picking the same file re-fires change.
                    e.target.value = ''
                  }}
                />
                <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  Choose file
                </Button>
                {fileName ? <p className="font-mono text-[11px] text-devdeck-dim">{fileName}</p> : null}
              </div>

              <div className="mb-3 flex items-end gap-3">
                <div className="w-56 flex-none">
                  <Label>Delimiter</Label>
                  <Select
                    value={delimiterChoice}
                    onValueChange={setDelimiterChoice}
                    options={DELIMITER_OPTIONS}
                    aria-label="Delimiter"
                  />
                </div>
                <label className="mb-2 flex items-center gap-2 text-[12px] text-devdeck-fg">
                  <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                  First row is a header
                </label>
              </div>

              {readError ? <p className="mb-2 text-[11.5px] text-devdeck-red-soft">{readError}</p> : null}

              {text === '' ? (
                <p className="text-[11.5px] text-devdeck-dim">No file loaded yet.</p>
              ) : parsed.headers.length === 0 ? (
                <p className="text-[11.5px] text-devdeck-red-soft">
                  Nothing parsed out of this file — check the delimiter and that the file is not empty.
                </p>
              ) : (
                <div className="rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5 font-mono text-[11px] text-devdeck-fg-2">
                  <div>
                    {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} · {parsed.headers.length} column
                    {parsed.headers.length === 1 ? '' : 's'} · delimiter{' '}
                    <span className="text-devdeck-accent-soft">{delimiterLabel(delimiter)}</span>
                    {delimiterChoice === AUTO ? ' (detected)' : ''}
                  </div>
                  <div className="mt-1 truncate text-devdeck-dim">{parsed.headers.join(' · ')}</div>
                  {parsed.errors.length > 0 ? (
                    <div className="mt-2 text-devdeck-yellow-tint-text">
                      {parsed.errors.length} ragged row{parsed.errors.length === 1 ? '' : 's'}:
                      {parsed.errors.slice(0, 5).map((e) => (
                        <div key={e.row}>
                          row {e.row}: {e.message}
                        </div>
                      ))}
                      {parsed.errors.length > 5 ? <div>…and {parsed.errors.length - 5} more</div> : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* ---- step 2: mapping ---- */}
          {step === 1 ? (
            <div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-devdeck-border-menu text-left">
                    <th className="pb-1.5 text-[11px] font-medium text-devdeck-dim">CSV column</th>
                    <th className="pb-1.5 text-[11px] font-medium text-devdeck-dim">Sample</th>
                    <th className="pb-1.5 text-[11px] font-medium text-devdeck-dim">Target column</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.headers.map((header, i) => (
                    <tr key={`${header}-${i}`} className="border-b border-devdeck-border-menu/50">
                      <td className="max-w-[160px] truncate py-1.5 pr-3 font-mono text-[11.5px] text-devdeck-fg-2">{header}</td>
                      <td className="max-w-[160px] truncate py-1.5 pr-3 font-mono text-[11px] text-devdeck-dim">
                        {parsed.rows[0]?.[i] ?? ''}
                      </td>
                      <td className="w-[240px] py-1.5">
                        <Select
                          value={mapping[header] ?? SKIP}
                          onValueChange={(v) => setMapping((prev) => ({ ...prev, [header]: v === SKIP ? null : v }))}
                          options={[
                            { value: SKIP, label: '— skip this column —' },
                            ...columns.map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.dataType}` })),
                          ]}
                          className="h-7"
                          aria-label={`Target column for ${header}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {missingRequired.length > 0 ? (
                <p className="mt-3 flex items-start gap-1.5 text-[11.5px] text-devdeck-yellow-tint-text">
                  <TriangleAlert size={12} className="mt-0.5 flex-none" />
                  <span>
                    Not mapped and NOT NULL without a default: <span className="font-mono">{missingRequired.join(', ')}</span>. Every
                    insert will fail unless the database supplies these another way.
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ---- step 3: preview ---- */}
          {step === 2 ? (
            <div>
              <p className="mb-2 text-[11.5px] text-devdeck-dim">
                First {previewRows.length} of {totalRows} row{totalRows === 1 ? '' : 's'}, with coercion applied.
              </p>
              {previewRows.length === 0 ? (
                <p className="text-[11.5px] text-devdeck-dim">Nothing to preview.</p>
              ) : (
                <div className="overflow-auto rounded-lg border border-devdeck-border-strong bg-devdeck-bg">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-devdeck-border-menu">
                        <th className="px-2 py-1 text-left font-mono text-[10px] text-devdeck-dim-2">#</th>
                        {previewRows[0].cells.map((c) => (
                          <th key={c.column} className="px-2 py-1 text-left font-mono text-[10px] text-devdeck-dim">
                            {c.column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((r) => (
                        <tr key={r.row} className={cn('border-b border-devdeck-border-menu/50', !r.ok && 'bg-devdeck-red-tint/30')}>
                          <td className="px-2 py-1 font-mono text-[10px] text-devdeck-dim-2">{r.row}</td>
                          {r.cells.map((c) => (
                            <td
                              key={c.column}
                              title={c.error ?? undefined}
                              className={cn(
                                'max-w-[150px] truncate px-2 py-1 font-mono text-[11px]',
                                c.error ? 'text-devdeck-red-soft' : 'text-devdeck-fg-2',
                              )}
                            >
                              {c.error ? c.error : c.value === null ? <span className="text-devdeck-dim-2">null</span> : String(c.value)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {errors.length > 0 ? (
                <div className="mt-3 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/30 p-2.5">
                  <div className="mb-1 text-[11.5px] font-medium text-devdeck-red-soft">
                    {errors.length} validation error{errors.length === 1 ? '' : 's'} across {skippedRows} row
                    {skippedRows === 1 ? '' : 's'} — those rows will be skipped.
                  </div>
                  <div className="max-h-[120px] overflow-auto font-mono text-[10.5px] text-devdeck-fg-2">
                    {errors.slice(0, 50).map((e, i) => (
                      <div key={`${e.row}-${e.column}-${i}`}>
                        row {e.row} · {e.column}: {e.message}
                      </div>
                    ))}
                    {errors.length > 50 ? <div className="text-devdeck-dim">…and {errors.length - 50} more</div> : null}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[11.5px] text-devdeck-green-soft">
                  All {totalRows} row{totalRows === 1 ? '' : 's'} validate.
                </p>
              )}
            </div>
          ) : null}

          {/* ---- step 4: execute ---- */}
          {step === 3 ? (
            <div>
              <div className="mb-3 w-64">
                <Label>Batch size</Label>
                <Select
                  value={batchSize}
                  onValueChange={setBatchSize}
                  options={BATCH_OPTIONS}
                  disabled={run.running}
                  aria-label="Batch size"
                />
              </div>

              <div className="mb-2 flex items-baseline justify-between font-mono text-[11px]">
                <span className="text-devdeck-fg-2">
                  {run.done} / {edits.length} row{edits.length === 1 ? '' : 's'}
                </span>
                <span className="text-devdeck-dim">{progressPercent(run.done, edits.length)}%</span>
              </div>
              <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-devdeck-border-menu">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-200',
                    run.failedBatch !== null ? 'bg-devdeck-red-soft' : 'bg-devdeck-accent',
                  )}
                  style={{ width: `${progressPercent(run.done, edits.length)}%` }}
                />
              </div>

              {skippedRows > 0 ? (
                <p className="mb-2 text-[11.5px] text-devdeck-yellow-tint-text">
                  {skippedRows} row{skippedRows === 1 ? '' : 's'} with validation errors will not be sent.
                </p>
              ) : null}

              {run.failedBatch !== null ? (
                <p className="mb-2 text-[11.5px] text-devdeck-red-soft">
                  Batch {run.failedBatch} failed: {run.error}. The {run.done} row{run.done === 1 ? '' : 's'} committed before it are
                  already in the table.
                </p>
              ) : run.stopped ? (
                <p className="mb-2 text-[11.5px] text-devdeck-yellow-tint-text">
                  Stopped after {run.inserted} inserted row{run.inserted === 1 ? '' : 's'} — the completed batches remain in the table.
                </p>
              ) : run.finished ? (
                <p className="mb-2 text-[11.5px] text-devdeck-green-soft">
                  Inserted {run.inserted} row{run.inserted === 1 ? '' : 's'}.
                </p>
              ) : run.running ? (
                <p className="mb-2 flex items-center gap-1.5 text-[11.5px] text-devdeck-dim">
                  <LoaderCircle size={12} className="animate-spin" />
                  Committing batch {Math.floor(run.done / Number(batchSize)) + 1} of {batches.length}…
                </p>
              ) : (
                <p className="mb-2 text-[11.5px] text-devdeck-dim">
                  {edits.length} row{edits.length === 1 ? '' : 's'} ready in {batches.length} batch{batches.length === 1 ? '' : 'es'}.
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2.5">
        {step > 0 && !run.running && !run.finished ? (
          <Button variant="secondary" onClick={() => setStep((s) => (s - 1) as StepIndex)}>
            Back
          </Button>
        ) : null}
        <div className="flex-1" />
        {run.running ? (
          <Button variant="destructive" onClick={() => { stopRequested.current = true }}>
            Stop after this batch
          </Button>
        ) : null}
        <Button variant="secondary" onClick={close} disabled={run.running}>
          {run.finished ? 'Close' : 'Cancel'}
        </Button>
        {step < 3 ? (
          <Button onClick={() => setStep((s) => (s + 1) as StepIndex)} disabled={!canAdvance || Boolean(columnsError) || !columns}>
            Next
          </Button>
        ) : (
          <Button onClick={() => void start()} disabled={run.running || run.finished || edits.length === 0}>
            {run.running && <LoaderCircle size={14} className="animate-spin" />}
            Run import
          </Button>
        )}
      </div>
    </Dialog>
  )
}
