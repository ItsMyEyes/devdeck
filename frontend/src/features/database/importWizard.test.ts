/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/importWizard.test.ts
 */

import {
  buildPreviewRows,
  countRowsWithErrors,
  mappedTargetColumns,
  progressPercent,
  unmappedRequiredColumns,
} from './importWizard'
import type { DBColumnMeta } from '@/lib/api'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

function col(name: string, dataType: string, extra: Partial<DBColumnMeta> = {}): DBColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    default: null,
    isPrimaryKey: false,
    ordinalPosition: 1,
    isLob: false,
    comparable: true,
    ...extra,
  }
}

// ---- mappedTargetColumns ----

check('mappedTargetColumns lists the mapped targets in header order', () => {
  const mapping = { email: 'email', id: 'id', name: null }
  assertEqual(mappedTargetColumns(mapping, ['id', 'name', 'email']), ['id', 'email'], 'header order, skips nulls')
})

check('mappedTargetColumns drops a header with no mapping entry at all', () => {
  // A header the wizard has not seen yet (mapping built before a re-parse)
  // must read as "skip", not as `undefined` leaking into the preview.
  assertEqual(mappedTargetColumns({ id: 'id' }, ['id', 'stray']), ['id'], 'missing key is a skip')
})

check('mappedTargetColumns de-duplicates a target claimed by two headers', () => {
  assertEqual(mappedTargetColumns({ a: 'name', b: 'name' }, ['a', 'b']), ['name'], 'one entry only')
})

check('mappedTargetColumns of an all-skip mapping is empty', () => {
  assertEqual(mappedTargetColumns({ a: null, b: null }, ['a', 'b']), [], 'empty')
})

// ---- unmappedRequiredColumns ----

check('unmappedRequiredColumns flags a NOT NULL column nobody maps to', () => {
  const columns = [col('id', 'integer', { nullable: false }), col('email', 'text', { nullable: false }), col('bio', 'text')]
  assertEqual(unmappedRequiredColumns({ id: 'id' }, ['id'], columns), ['email'], 'email is required and unmapped')
})

check('unmappedRequiredColumns ignores nullable columns', () => {
  const columns = [col('bio', 'text'), col('nickname', 'text')]
  assertEqual(unmappedRequiredColumns({}, [], columns), [], 'nullable columns need no mapping')
})

check('unmappedRequiredColumns ignores a NOT NULL column that has a default', () => {
  // `id serial primary key` is nullable:false with default nextval(...). It
  // cannot fail an insert, so warning about it on every single import would
  // train the operator to ignore the warning entirely.
  const columns = [
    col('id', 'integer', { nullable: false, default: "nextval('t_id_seq'::regclass)", isPrimaryKey: true }),
    col('created_at', 'timestamp', { nullable: false, default: 'now()' }),
    col('email', 'text', { nullable: false }),
  ]
  assertEqual(unmappedRequiredColumns({}, [], columns), ['email'], 'only the defaultless column warns')
})

check('unmappedRequiredColumns treats an empty-string default as no default', () => {
  const columns = [col('email', 'text', { nullable: false, default: '' })]
  assertEqual(unmappedRequiredColumns({}, [], columns), ['email'], 'empty string is not a real default')
})

check('unmappedRequiredColumns only counts targets reachable from the header list', () => {
  // A stale mapping entry for a header that is no longer in the file must not
  // silence the warning — nothing will write that column.
  const columns = [col('email', 'text', { nullable: false })]
  assertEqual(unmappedRequiredColumns({ old_email: 'email' }, ['id'], columns), ['email'], 'stale mapping does not count')
})

// ---- buildPreviewRows ----

const previewColumns = [col('id', 'integer', { nullable: false }), col('name', 'text'), col('active', 'boolean')]

check('buildPreviewRows coerces each mapped cell and reports ok rows', () => {
  const rows = buildPreviewRows(
    { id: 'id', nickname: null, active: 'active' },
    ['id', 'nickname', 'active'],
    [['1', 'ada', 'yes']],
    previewColumns,
    10,
  )
  assertEqual(rows.length, 1, 'one row')
  assertEqual(rows[0].row, 1, '1-based row number')
  assertEqual(rows[0].ok, true, 'no errors')
  assertEqual(rows[0].cells, [
    { column: 'id', value: 1, error: null },
    { column: 'active', value: true, error: null },
  ], 'skipped header contributes no cell; values are coerced')
})

check('buildPreviewRows caps the output at the requested limit', () => {
  const data = Array.from({ length: 25 }, (_, i) => [String(i + 1), 'x', 'true'])
  const rows = buildPreviewRows({ id: 'id' }, ['id', 'name', 'active'], data, previewColumns, 10)
  assertEqual(rows.length, 10, 'first 10 only')
  assertEqual(rows[9].row, 10, 'row numbers stay 1-based and contiguous')
})

check('buildPreviewRows records a per-cell error instead of throwing', () => {
  const rows = buildPreviewRows({ id: 'id' }, ['id'], [['not-a-number']], previewColumns, 10)
  assertEqual(rows[0].ok, false, 'row is not ok')
  assertEqual(rows[0].cells[0].value, null, 'a failed cell has no value')
  assertEqual(rows[0].cells[0].error !== null, true, 'error message present')
})

check('buildPreviewRows treats a missing cell in a short row as an empty string', () => {
  const rows = buildPreviewRows({ id: 'id', name: 'name' }, ['id', 'name'], [['7']], previewColumns, 10)
  assertEqual(rows[0].cells[1], { column: 'name', value: null, error: null }, 'nullable text -> null')
})

check('buildPreviewRows flags a mapping that points at a column the table does not have', () => {
  const rows = buildPreviewRows({ id: 'ghost' }, ['id'], [['1']], previewColumns, 10)
  assertEqual(rows[0].ok, false, 'not ok')
  assertEqual(rows[0].cells[0].error, 'no column named "ghost" in the target table', 'explicit message')
})

check('buildPreviewRows on zero rows returns an empty list', () => {
  assertEqual(buildPreviewRows({ id: 'id' }, ['id'], [], previewColumns, 10), [], 'empty')
})

// ---- countRowsWithErrors ----

check('countRowsWithErrors counts distinct rows, not cells', () => {
  const errors = [
    { row: 1, column: 'id', message: 'bad' },
    { row: 1, column: 'active', message: 'bad' },
    { row: 4, column: 'id', message: 'bad' },
  ]
  assertEqual(countRowsWithErrors(errors), 2, 'row 1 counted once')
})

check('countRowsWithErrors of an empty list is zero', () => {
  assertEqual(countRowsWithErrors([]), 0, 'zero')
})

// ---- progressPercent ----

check('progressPercent rounds down so a partial batch never reads as 100%', () => {
  assertEqual(progressPercent(999, 1000), 99, '999/1000 is not done')
  assertEqual(progressPercent(1000, 1000), 100, 'complete')
  assertEqual(progressPercent(1, 3), 33, 'floor')
})

check('progressPercent clamps out-of-range input', () => {
  assertEqual(progressPercent(-5, 100), 0, 'negative done')
  assertEqual(progressPercent(150, 100), 100, 'overshoot')
})

check('progressPercent of a zero total is 0 rather than NaN', () => {
  assertEqual(progressPercent(0, 0), 0, 'no division by zero')
  assertEqual(progressPercent(5, -1), 0, 'negative total')
})

console.log(`\n${passed} tests passed`)
