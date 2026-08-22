import { useState } from 'react'
import { cn } from '@/lib/utils'
import { MAX_COLUMNS, MAX_ROWS, readWorkbook } from './sheet'
import type { Workbook } from './sheet'
import { DocumentParseState } from './DocumentParseState'
import { SheetGridTable } from './SheetGridTable'
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
    <div className="flex min-h-0 flex-1 flex-col bg-devdeck-pane">
      <SheetGridTable
        rows={sheet.rows}
        columnCount={sheet.columnCount}
        emptyLabel={`${sheet.name} is empty`}
      />

      {sheet.truncated ? (
        <div className="flex-none border-t border-devdeck-border bg-devdeck-card-wash px-3 py-1.5 font-mono text-[10px] text-devdeck-yellow">
          Showing the first {Math.min(sheet.totalRows, MAX_ROWS).toLocaleString()} of{' '}
          {sheet.totalRows.toLocaleString()} rows and{' '}
          {Math.min(sheet.totalColumns, MAX_COLUMNS)} of {sheet.totalColumns} columns - download the
          file to see all of it.
        </div>
      ) : null}

      {sheets.length > 1 ? (
        <div className="flex flex-none items-center gap-1 overflow-x-auto border-t border-devdeck-border bg-devdeck-pane px-2 py-1">
          {sheets.map((candidate, index) => (
            <button
              key={`${candidate.name}-${index}`}
              type="button"
              onClick={() => setActiveSheet(index)}
              className={cn(
                'flex-none cursor-pointer rounded px-2.5 py-1 font-mono text-[11px]',
                index === activeSheet
                  ? 'bg-devdeck-glass-solid text-devdeck-fg'
                  : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
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

