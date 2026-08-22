import { cn } from '@/lib/utils'
import { columnLabel } from './sheet'

/**
 * The spreadsheet grid shared by the Excel viewer and the CSV viewer: a
 * scrollable table with a pinned A/B/C column header and a pinned 1/2/3 row
 * gutter.
 *
 * Three things here are load-bearing, and getting any of them wrong is what
 * made the first version read as "berbayang dan jelek" — ghosted and ugly:
 *
 *  1. **The pinned cells must be OPAQUE.** They used to be painted with
 *     `--devdeck-card-wash`, which is `rgba(255,255,255,.055)` — a translucent
 *     film whose whole job is to sit "one step off whatever is behind me"
 *     (globals.css). Behind a sticky header, what is behind it is the rows
 *     scrolling under it, so every column letter had a data row showing
 *     straight through it. `--devdeck-card` is the opaque chrome step and has
 *     a real value in both themes.
 *
 *  2. **`border-separate`, not `border-collapse`.** With collapsed borders the
 *     border belongs to the TABLE, not the cell, so it does not travel with a
 *     `position: sticky` cell — the header's own outline scrolls away and
 *     leaves the misaligned boxes visible in the report. Separated borders
 *     with zero spacing look identical and actually stick; the doubling that
 *     normally argues for collapse is avoided by drawing only the right and
 *     bottom edge of each cell.
 *
 *  3. **A z-order with three levels, not two.** The corner cell overlaps both
 *     bars, the header overlaps the gutter, and both overlap the data. Two
 *     levels leave the corner cell transparent to the row numbers sliding
 *     under it.
 */
export function SheetGridTable({
  rows,
  columnCount,
  /** Rendered in the header instead of A/B/C — the CSV grid's first row. */
  headers,
  emptyLabel,
}: {
  rows: string[][]
  columnCount: number
  headers?: string[]
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-pane">
        <span className="font-mono text-[11px] text-devdeck-fg-2">{emptyLabel}</span>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-devdeck-pane">
      <table className="w-full border-separate border-spacing-0 font-mono text-[11.5px]">
        <thead>
          <tr>
            <th
              className={cn(
                'sticky top-0 left-0 z-30 w-12 min-w-12',
                'border-r border-b border-devdeck-border-menu bg-devdeck-card',
                'px-2 py-1',
              )}
            />
            {Array.from({ length: columnCount }, (_, index) => (
              <th
                key={index}
                title={headers?.[index] || undefined}
                className={cn(
                  'sticky top-0 z-20 min-w-24 max-w-80 truncate',
                  'border-r border-b border-devdeck-border-menu bg-devdeck-card',
                  'px-2 py-1 font-medium text-devdeck-fg-2',
                  // A named CSV column reads as a label and belongs over its
                  // data, on the left. A bare A/B/C is chrome for the column
                  // itself and centres, the way every spreadsheet draws it.
                  headers ? 'text-left' : 'text-center',
                )}
              >
                {headers ? headers[index] || columnLabel(index) : columnLabel(index)}
              </th>
            ))}
            {/* Filler. Without it the table is exactly as wide as its content,
                so on any pane wider than the data the rows stop in mid-air and
                the last column's border floats down the middle of an empty
                pane. `w-full` on a cell in an auto-layout table hands it all
                the slack and leaves the real columns at their measured widths,
                which is how a spreadsheet looks. */}
            <th className="sticky top-0 z-20 w-full border-b border-devdeck-border-menu bg-devdeck-card" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="group">
              <td
                className={cn(
                  'sticky left-0 z-10 w-12 min-w-12',
                  'border-r border-b border-devdeck-border-menu bg-devdeck-card',
                  'px-2 py-1 text-right tabular-nums text-devdeck-fg-2',
                  // Selecting a range of cells and pasting it elsewhere should
                  // not drag the row numbers along — they are chrome, not data.
                  'select-none',
                )}
              >
                {rowIndex + 1}
              </td>
              {Array.from({ length: columnCount }, (_, columnIndex) => {
                const cell = row[columnIndex] ?? ''
                return (
                  <td
                    key={columnIndex}
                    title={cell || undefined}
                    className={cn(
                      'max-w-80 truncate border-r border-b border-devdeck-border-card px-2 py-1',
                      // The data is the point of this view, so it gets the
                      // readable foreground. Everything that frames it — the
                      // header letters, the row numbers — stays on the muted
                      // one. It was all fg-2 before, which is why the whole
                      // grid read as washed out.
                      'text-devdeck-fg group-hover:bg-devdeck-hover-wash',
                      // Right-align things that read as numbers, the way a
                      // spreadsheet does — purely a display heuristic on the
                      // already-formatted string.
                      isNumericText(cell) && 'text-right tabular-nums',
                    )}
                  >
                    {cell}
                  </td>
                )
              })}
              <td className="w-full border-b border-devdeck-border-card group-hover:bg-devdeck-hover-wash" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function isNumericText(value: string): boolean {
  if (value === '') return false
  return /^-?[\d,]+(\.\d+)?%?$/.test(value)
}
