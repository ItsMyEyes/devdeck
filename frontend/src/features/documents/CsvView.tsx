import { useMemo } from 'react'
import { detectDelimiter, parseCSV } from '@/features/database/csv'
import { MAX_COLUMNS, MAX_ROWS } from './sheet'
import { SheetGridTable } from './SheetGridTable'

/**
 * A delimited-text file as a grid.
 *
 * Parsing is `@/features/database/csv` — the RFC 4180 reader the import wizard
 * already uses, quoting rules and all. Writing a second one here would mean a
 * `"a,b",c` line rendering as three columns in one surface and two in the
 * other, and only one of them would have tests.
 *
 * The first record is treated as the header, which is what a data file almost
 * always is; when it plainly is not (a headerless export), the values still
 * show — they just show in the header bar, in the same order, which is the
 * failure mode a reader can see and reason about.
 */
export function CsvView({ bytes }: { bytes: Uint8Array }) {
  const grid = useMemo(() => buildGrid(bytes), [bytes])

  if (grid.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-pane px-6">
        <span className="max-w-lg text-center font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {grid.error}
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-devdeck-pane">
      <SheetGridTable
        rows={grid.rows}
        columnCount={grid.columnCount}
        headers={grid.headers}
        emptyLabel="This file has no rows"
      />
      {grid.truncated ? (
        <div className="flex-none border-t border-devdeck-border bg-devdeck-card px-3 py-1.5 font-mono text-[10px] text-devdeck-yellow">
          Showing the first {Math.min(grid.totalRows, MAX_ROWS).toLocaleString()} of{' '}
          {grid.totalRows.toLocaleString()} rows and {Math.min(grid.totalColumns, MAX_COLUMNS)} of{' '}
          {grid.totalColumns} columns - download the file to see all of it.
        </div>
      ) : null}
    </div>
  )
}

export interface CsvGrid {
  headers: string[]
  rows: string[][]
  columnCount: number
  totalRows: number
  totalColumns: number
  truncated: boolean
  error?: string
}

/**
 * Bytes -> the shape SheetGridTable renders. Exported for tests: this is where
 * every decision that can visibly go wrong lives (decoding, delimiter, the
 * ragged-row padding, the caps), and it is all pure.
 *
 * Capped at the same MAX_ROWS/MAX_COLUMNS as the workbook reader. A CSV has no
 * size ceiling of its own — a 400MB log exported to .csv is an ordinary thing
 * to find in a worktree — and handing a million <tr>s to React locks the tab
 * for minutes. The banner says what was cut, rather than the grid quietly
 * lying about how much data there is.
 */
export function buildGrid(bytes: Uint8Array): CsvGrid {
  const empty: CsvGrid = {
    headers: [],
    rows: [],
    columnCount: 0,
    totalRows: 0,
    totalColumns: 0,
    truncated: false,
  }

  let text: string
  try {
    // `fatal` so mojibake is reported rather than rendered: a CSV written in
    // latin-1 would otherwise come out as a grid full of replacement
    // characters, which reads as "the viewer is broken".
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ...empty, error: 'This file is not valid UTF-8 text, so it cannot be read as CSV.' }
  }
  if (text.trim() === '') return empty

  // Delimiter voting only needs a sample, and running it over a 400MB string
  // is pure waste — the first few lines settle it.
  const { headers, rows } = parseCSV(text, { delimiter: detectDelimiter(text.slice(0, 64 * 1024)) })

  const totalRows = rows.length
  const totalColumns = rows.reduce((widest, row) => Math.max(widest, row.length), headers.length)
  const columnCount = Math.min(totalColumns, MAX_COLUMNS)
  const capped = rows.slice(0, MAX_ROWS)

  return {
    headers: headers.slice(0, columnCount),
    // Padded to a rectangle here rather than in the table: a ragged CSV is
    // normal, and a row that ends early must still draw its remaining cells or
    // the grid lines break up mid-row.
    rows: capped.map((row) =>
      Array.from({ length: columnCount }, (_, index) => row[index] ?? ''),
    ),
    columnCount,
    totalRows,
    totalColumns,
    truncated: totalRows > MAX_ROWS || totalColumns > MAX_COLUMNS,
  }
}
