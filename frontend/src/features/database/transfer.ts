/** Cross-connection table transfer: turning a source page of rows into
 *  target-side insert edits, and the paging/rate arithmetic around it.
 *
 *  `typeMap.ts` owns the CREATE TABLE plan for the target side; this module
 *  owns the row-copy loop's pure parts. Pure functions —
 *  see `npx tsx src/features/database/transfer.test.ts`.
 */

import type { DBColumnMeta, DBObjectRef, DBRowEdit, DBRowsRequest } from '@/lib/api'

/** Names of the columns whose *values* a transfer refuses to carry.
 *
 *  A LOB round-trips through JSON as whatever the driver rendered it as (a
 *  byte count, a base64 blob, a truncated preview) — writing that string into
 *  the target would silently corrupt the column. The transfer dialog lists
 *  these up front so the operator knows what the copy will not include.
 */
export function lobColumnNames(columns: DBColumnMeta[]): string[] {
  return columns.filter((c) => c.isLob).map((c) => c.name)
}

/** Source columns whose values actually move, in their original order. */
export function transferableColumns(columns: DBColumnMeta[]): DBColumnMeta[] {
  return columns.filter((c) => !c.isLob)
}

/** Maps a page of source rows (positional, aligned to `columns`) into
 *  name-keyed insert edits against the target object.
 *
 *  Keyed by name rather than position because the target table's column order
 *  need not match the source's — a pre-existing target, or one created by a
 *  plan the operator edited, can differ. LOB columns are skipped per
 *  `lobColumnNames`. A cell missing from a short row is omitted entirely
 *  rather than sent as undefined, letting the target apply its own default.
 */
export function buildTransferEdits(
  targetObject: DBObjectRef,
  columns: DBColumnMeta[],
  rows: unknown[][],
): DBRowEdit[] {
  return rows.map((row) => {
    const newValues: Record<string, unknown> = {}
    for (let i = 0; i < columns.length; i += 1) {
      if (columns[i].isLob) continue
      if (i >= row.length) continue
      newValues[columns[i].name] = row[i]
    }
    return { object: targetObject, kind: 'insert' as const, newValues }
  })
}

/** The next source page to request.
 *
 *  Keyset paging is preferred (stable under concurrent writes), but a table
 *  with no usable row identity makes the server fall back to OFFSET and
 *  return no meaningful cursor — in that case the running transferred-row
 *  count is the only way forward, so the cursor is dropped explicitly rather
 *  than sent alongside an offset the server would then ignore.
 *
 *  No filters, sort or search: a transfer copies the table, and imposing an
 *  ORDER BY here would fight the server's own keyset ordering.
 */
export function nextPageRequest(
  sourceObject: DBObjectRef,
  batchSize: number,
  cursor: unknown[] | null,
  rowsDone: number,
  usedOffsetPaging: boolean,
): DBRowsRequest {
  return {
    object: sourceObject,
    filters: [],
    sort: [],
    cursor: usedOffsetPaging ? null : cursor,
    offset: usedOffsetPaging ? rowsDone : 0,
    limit: batchSize,
    globalSearch: '',
  }
}

/** Whole rows per second over `elapsedMs`. A zero or negative elapsed (the
 *  first tick, or a clock adjustment mid-transfer) reads as 0 rather than
 *  Infinity/NaN. */
export function rowsPerSecond(rows: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  return Math.round(rows / (elapsedMs / 1000))
}
