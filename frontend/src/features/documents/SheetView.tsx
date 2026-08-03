import { useState } from 'react'
import { cn } from '@/lib/utils'
import { columnLabel, MAX_COLUMNS, MAX_ROWS, readWorkbook } from './sheet'
import type { SheetGrid, Workbook } from './sheet'
import { DocumentParseState } from './DocumentParseState'
import { useAsyncParse } from './useAsyncParse'
import { readZip } from './zip'

const parse = async (bytes: Uint8Array): Promise<Workbook> => readWorkbook(readZip(bytes))

export function SheetView({ bytes }: { bytes: Uint8Array }) {
  const state = useAsyncParse(bytes, parse)
  const [activeSheet, setActiveSheet] = useState(0)

  if (state.status !== 'ready' || !state.data) {
    return <DocumentParseState state={state} label="Reading workbook…" />
  }

  const { sheets } = state.data
  // The tab index is component state, so it can outlive a document swap
  // (open workbook A on sheet 3, open workbook B with two sheets).
  const sheet = sheets[Math.min(activeSheet, sheets.length - 1)]
  if (!sheet) {
    return <DocumentParseState state={{ status: 'ready' }} emptyLabel="This workbook is empty" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-devdeck-terminal">
      <Grid sheet={sheet} />

      {sheet.truncated ? (
        <div className="flex-none border-t border-devdeck-border bg-devdeck-surface-2 px-3 py-1.5 font-mono text-[10px] text-devdeck-yellow">
          Showing the first {Math.min(sheet.totalRows, MAX_ROWS).toLocaleString()} of{' '}
          {sheet.totalRows.toLocaleString()} rows and{' '}
          {Math.min(sheet.totalColumns, MAX_COLUMNS)} of {sheet.totalColumns} columns — download the
          file to see all of it.
        </div>
      ) : null}

      {sheets.length > 1 ? (
        <div className="flex flex-none items-center gap-1 overflow-x-auto border-t border-devdeck-border bg-devdeck-surface px-2 py-1">
          {sheets.map((candidate, index) => (
            <button
              key={`${candidate.name}-${index}`}
              type="button"
              onClick={() => setActiveSheet(index)}
              className={cn(
                'flex-none cursor-pointer rounded px-2.5 py-1 font-mono text-[11px]',
                index === activeSheet
                  ? 'bg-devdeck-elevated text-devdeck-fg'
                  : 'text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
              )}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Grid({ sheet }: { sheet: SheetGrid }) {
  if (sheet.rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="font-mono text-[11px] text-devdeck-dim">{sheet.name} is empty</span>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="border-collapse font-mono text-[11.5px]">
        <thead>
          {/* Sticky spreadsheet headers: the A/B/C row and the 1/2/3 gutter
              both pin, so a wide sheet stays navigable while scrolled. */}
          <tr>
            <th className="sticky left-0 top-0 z-20 w-12 border border-devdeck-border bg-devdeck-surface-2 px-2 py-1 text-devdeck-dim" />
            {Array.from({ length: sheet.columnCount }, (_, index) => (
              <th
                key={index}
                className="sticky top-0 z-10 min-w-24 border border-devdeck-border bg-devdeck-surface-2 px-2 py-1 font-normal text-devdeck-dim"
              >
                {columnLabel(index)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="sticky left-0 z-10 border border-devdeck-border bg-devdeck-surface-2 px-2 py-1 text-right text-devdeck-dim">
                {rowIndex + 1}
              </td>
              {row.map((cell, columnIndex) => (
                <td
                  key={columnIndex}
                  title={cell || undefined}
                  className={cn(
                    'max-w-80 truncate border border-devdeck-border px-2 py-1 text-devdeck-fg-2',
                    // Right-align things that read as numbers, the way a
                    // spreadsheet does — purely a display heuristic on the
                    // already-formatted string.
                    isNumericText(cell) && 'text-right tabular-nums',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function isNumericText(value: string): boolean {
  if (value === '') return false
  return /^-?[\d,]+(\.\d+)?%?$/.test(value)
}
