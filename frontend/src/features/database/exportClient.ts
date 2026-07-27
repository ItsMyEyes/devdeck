/** Client-side encoding of an in-memory `DBResultSet`.
 *
 *  The SQL editor already holds its result set in memory, so "download these
 *  results" needs no server round-trip (and no re-running of a query that may
 *  not be deterministic). Table exports still go through the streaming
 *  server-side endpoint; this is the ad-hoc path.
 *
 *  Pure functions — see `npx tsx src/features/database/exportClient.test.ts`.
 */

import type { DBResultSet } from '@/lib/api'

const CSV_DELIMITER = ','

/** Renders one cell as its CSV text, before quoting. null/undefined become
 *  the empty string (an unquoted empty field, which `parseCSV` reads back as
 *  ''); objects and arrays are JSON-stringified so structured columns (json,
 *  jsonb, arrays) survive as a single field. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** RFC 4180: quote only when the field contains the delimiter, a quote, or a
 *  line break; escape embedded quotes by doubling them. */
function quoteCSV(field: string): string {
  if (
    field.includes(CSV_DELIMITER) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r')
  ) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

/** Encodes a result set as RFC 4180 CSV with a header row.
 *
 *  Rows are padded to the column count so the output is always rectangular —
 *  a short row from a driver would otherwise produce a file that re-imports
 *  as ragged. Cells past the declared columns are ignored for the same
 *  reason. Records are joined with LF; the output has no trailing newline.
 */
export function resultToCSV(rs: DBResultSet): string {
  const names = rs.columns.map((c) => c.name)
  if (names.length === 0) return ''

  const lines: string[] = [names.map((n) => quoteCSV(n)).join(CSV_DELIMITER)]
  for (const row of rs.rows) {
    const fields: string[] = []
    for (let i = 0; i < names.length; i += 1) {
      fields.push(quoteCSV(csvCell(row[i])))
    }
    lines.push(fields.join(CSV_DELIMITER))
  }
  return lines.join('\n')
}

/** Encodes a result set as a pretty-printed (2-space) JSON array of objects
 *  keyed by column name.
 *
 *  null is preserved as JSON null, and a missing cell is normalized to null
 *  rather than left `undefined` — `JSON.stringify` drops undefined-valued
 *  keys, which would make rows structurally inconsistent. A result set with
 *  duplicate column names collapses to the last value, per plain JS object
 *  semantics.
 */
export function resultToJSON(rs: DBResultSet): string {
  const names = rs.columns.map((c) => c.name)
  const objects = rs.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < names.length; i += 1) {
      obj[names[i]] = row[i] === undefined ? null : row[i]
    }
    return obj
  })
  return JSON.stringify(objects, null, 2)
}
