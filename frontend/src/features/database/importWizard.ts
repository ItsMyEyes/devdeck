/** Derived state for the CSV import wizard: what a mapping actually covers,
 *  which required columns it leaves behind, the coerced preview grid, and the
 *  execute-step progress arithmetic.
 *
 *  `importMap.ts` owns the coercion and edit-building rules; this module only
 *  turns them into the shapes the wizard renders. Pure functions —
 *  see `npx tsx src/features/database/importWizard.test.ts`.
 */

import type { DBColumnMeta } from '@/lib/api'
import { coerceValue, type ImportCellError } from './importMap'

export interface PreviewCell {
  /** Target column name (never the CSV header). */
  column: string
  /** The coerced value, or null when `error` is set — a failed cell has no
   *  value to show, and rendering the raw string there would look like it
   *  succeeded. */
  value: unknown
  error: string | null
}

export interface PreviewRow {
  /** 1-based index into the parsed data rows, matching `ImportCellError.row`
   *  so the preview and the error list agree on row numbering. */
  row: number
  cells: PreviewCell[]
  ok: boolean
}

/** The distinct target columns a mapping writes, in CSV header order.
 *  Headers mapped to null (or absent from the mapping entirely) are skips. */
export function mappedTargetColumns(mapping: Record<string, string | null>, headers: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const header of headers) {
    const target = mapping[header] ?? null
    if (target === null || seen.has(target)) continue
    seen.add(target)
    out.push(target)
  }
  return out
}

/** NOT NULL target columns that no header writes AND that have no database
 *  default to fall back on — the ones whose absence will actually fail the
 *  insert.
 *
 *  A `serial`/`now()` column is nullable:false but always satisfiable, so
 *  warning about it on every import would make the warning noise. Only the
 *  columns the operator genuinely has to map are listed.
 */
export function unmappedRequiredColumns(
  mapping: Record<string, string | null>,
  headers: string[],
  columns: DBColumnMeta[],
): string[] {
  const mapped = new Set(mappedTargetColumns(mapping, headers))
  return columns
    .filter((c) => !c.nullable && (c.default === null || c.default === '') && !mapped.has(c.name))
    .map((c) => c.name)
}

/** Applies the mapping and per-cell coercion to the first `limit` rows so the
 *  operator sees the values as the database will receive them, not the raw
 *  CSV text. Errors are carried on the cell rather than thrown: one bad cell
 *  must not blank the whole preview. */
export function buildPreviewRows(
  mapping: Record<string, string | null>,
  headers: string[],
  rows: string[][],
  columns: DBColumnMeta[],
  limit: number,
): PreviewRow[] {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const targets = headers.map((h) => mapping[h] ?? null)

  const out: PreviewRow[] = []
  for (let r = 0; r < rows.length && out.length < limit; r += 1) {
    const cells: PreviewCell[] = []
    let ok = true

    for (let c = 0; c < targets.length; c += 1) {
      const target = targets[c]
      if (target === null) continue

      const meta = byName.get(target)
      if (meta === undefined) {
        cells.push({ column: target, value: null, error: `no column named "${target}" in the target table` })
        ok = false
        continue
      }

      const result = coerceValue(rows[r][c] ?? '', meta)
      if (result.ok) {
        cells.push({ column: target, value: result.value, error: null })
      } else {
        cells.push({ column: target, value: null, error: result.error })
        ok = false
      }
    }

    out.push({ row: r + 1, cells, ok })
  }
  return out
}

/** How many *rows* the cell errors span. `buildInsertEdits` reports every bad
 *  cell, so a row with three bad columns must still count as one skipped row
 *  in the "N rows will be skipped" summary. */
export function countRowsWithErrors(errors: ImportCellError[]): number {
  return new Set(errors.map((e) => e.row)).size
}

/** Integer percent for the progress bar, floored so an in-flight final batch
 *  never displays 100%, and clamped so a miscounted total can't render a bar
 *  wider than its track. A zero/negative total is 0, not NaN. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  const pct = Math.floor((done / total) * 100)
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}
