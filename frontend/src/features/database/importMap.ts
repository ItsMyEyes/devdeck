/** CSV -> table import: header/column mapping, per-cell type coercion, and
 *  batching into the `DBRowEdit`s the commit endpoint already accepts.
 *
 *  Pure functions only — the wizard owns the file reading and the mutation;
 *  this module is the part worth testing
 *  (`npx tsx src/features/database/importMap.test.ts`).
 */

import type { DBColumnMeta, DBObjectRef, DBRowEdit } from '@/lib/api'

/** The coarse family a column's engine-specific type belongs to, as far as
 *  *importing a string* is concerned. Deliberately coarser than
 *  `dbColors.classifyDataType` (which drives grid badges): dates, json, uuid
 *  and text all pass through untouched here, so they share one family. */
export type TypeFamily = 'integer' | 'float' | 'boolean' | 'text'

export interface CoerceOk {
  ok: true
  value: unknown
}

export interface CoerceErr {
  ok: false
  error: string
}

export type CoerceResult = CoerceOk | CoerceErr

export interface ImportCellError {
  /** 1-based index into the `rows` array passed to `buildInsertEdits`. */
  row: number
  /** The *target* column name (not the CSV header) the cell failed on. */
  column: string
  message: string
}

export interface BuildInsertEditsResult {
  edits: DBRowEdit[]
  errors: ImportCellError[]
}

const TRUE_LITERALS = new Set(['true', 't', '1', 'yes', 'y'])
const FALSE_LITERALS = new Set(['false', 'f', '0', 'no', 'n'])

const FLOAT_TYPES = ['real', 'double', 'float', 'numeric', 'decimal']

/** Classifies an engine-specific SQL type into an import coercion family.
 *
 *  Order matters: `tinyint(1)` is MySQL's boolean and must be caught by the
 *  bool check before the "contains int" check claims it. `point` is excluded
 *  from the integer check for the same reason `dbColors` excludes it — the
 *  substring "int" appears inside it. Postgres's `serial`/`bigserial` are
 *  integers too, despite containing no "int". */
export function classifyTypeFamily(dataType: string): TypeFamily {
  const t = dataType.toLowerCase()
  if (t.includes('bool') || t.startsWith('tinyint(1)')) return 'boolean'
  if (FLOAT_TYPES.some((f) => t.includes(f))) return 'float'
  if ((t.includes('int') && !t.includes('point')) || t.includes('serial')) return 'integer'
  return 'text'
}

/** Canonical form used to compare a CSV header against a column name:
 *  case-folded, with underscores / dashes / spaces treated as one and the
 *  same separator. "First Name", "first-name" and "first_name" all collapse
 *  to "first_name". */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, '_')
}

/** Best-effort mapping of each CSV header to a target column name, or null
 *  when nothing matches (the wizard renders null as "skip"). A column is
 *  claimed by at most one header — the first one, in header order — so two
 *  headers that normalize identically can never both write the same column. */
export function autoMapColumns(headers: string[], columns: DBColumnMeta[]): Record<string, string | null> {
  const byNormalized = new Map<string, string>()
  for (const c of columns) {
    const key = normalizeName(c.name)
    if (!byNormalized.has(key)) byNormalized.set(key, c.name)
  }

  const claimed = new Set<string>()
  const mapping: Record<string, string | null> = {}
  for (const header of headers) {
    const target = byNormalized.get(normalizeName(header))
    if (target !== undefined && !claimed.has(target)) {
      claimed.add(target)
      mapping[header] = target
    } else {
      mapping[header] = null
    }
  }
  return mapping
}

/** Coerces one raw CSV string into the value the commit endpoint should
 *  receive for `col`.
 *
 *  - Empty string -> null on a nullable column; on a NOT NULL column it stays
 *    an empty string for text families and is an error for everything else
 *    (an empty numeric/boolean has no sensible value).
 *  - Integers are parsed strictly: `parseInt("12abc")` would silently yield
 *    12, so a full-string regex is used instead.
 *  - Floats go through `Number`, rejecting NaN and non-finite results.
 *  - Booleans accept the usual true/false/t/f/1/0/yes/no spellings.
 *  - Everything else (text, dates, json, uuid) passes through verbatim —
 *    including surrounding whitespace, and without re-encoding JSON. The
 *    server-side driver does the final conversion.
 */
export function coerceValue(raw: string, col: DBColumnMeta): CoerceResult {
  const family = classifyTypeFamily(col.dataType)

  if (raw === '') {
    if (col.nullable) return { ok: true, value: null }
    if (family === 'text') return { ok: true, value: '' }
    return { ok: false, error: `${col.name} is NOT NULL and ${col.dataType} has no empty value` }
  }

  if (family === 'text') return { ok: true, value: raw }

  const trimmed = raw.trim()

  if (family === 'integer') {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return { ok: false, error: `"${raw}" is not a valid ${col.dataType}` }
    }
    return { ok: true, value: Number(trimmed) }
  }

  if (family === 'float') {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) {
      return { ok: false, error: `"${raw}" is not a valid ${col.dataType}` }
    }
    return { ok: true, value: n }
  }

  const lower = trimmed.toLowerCase()
  if (TRUE_LITERALS.has(lower)) return { ok: true, value: true }
  if (FALSE_LITERALS.has(lower)) return { ok: true, value: false }
  return { ok: false, error: `"${raw}" is not a valid ${col.dataType}` }
}

/** Turns parsed CSV rows into `kind: "insert"` row edits for the commit
 *  endpoint.
 *
 *  A row with *any* bad cell produces no edit at all — a partially-coerced
 *  insert would write a row the user never described. Every bad cell is still
 *  reported (not just the first), so one pass surfaces the whole problem.
 *  A cell missing entirely (a short/ragged row) is treated as an empty
 *  string, which the nullable rules above then turn into null or an error.
 */
export function buildInsertEdits(
  object: DBObjectRef,
  mapping: Record<string, string | null>,
  headers: string[],
  rows: string[][],
  columns: DBColumnMeta[],
): BuildInsertEditsResult {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const targets = headers.map((h) => mapping[h] ?? null)

  const edits: DBRowEdit[] = []
  const errors: ImportCellError[] = []

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    const newValues: Record<string, unknown> = {}
    let rowOK = true

    for (let c = 0; c < targets.length; c += 1) {
      const target = targets[c]
      if (target === null) continue

      const meta = byName.get(target)
      if (meta === undefined) {
        errors.push({ row: r + 1, column: target, message: `no column named "${target}" in ${object.name}` })
        rowOK = false
        continue
      }

      const result = coerceValue(row[c] ?? '', meta)
      if (!result.ok) {
        errors.push({ row: r + 1, column: target, message: result.error })
        rowOK = false
        continue
      }
      newValues[target] = result.value
    }

    if (rowOK) edits.push({ object, kind: 'insert', newValues })
  }

  return { edits, errors }
}

/** Splits `items` into batches of at most `size`. A non-positive size would
 *  otherwise loop forever, so it degrades to a single batch. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  if (size <= 0) return [items.slice()]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
