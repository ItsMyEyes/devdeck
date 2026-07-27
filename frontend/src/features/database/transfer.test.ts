/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/transfer.test.ts
 */

import {
  buildTransferEdits,
  lobColumnNames,
  nextPageRequest,
  rowsPerSecond,
  transferableColumns,
} from './transfer'
import type { DBColumnMeta, DBObjectRef } from '@/lib/api'

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

const target: DBObjectRef = { database: 'app', schema: 'public', name: 'users', kind: 'table' }

// ---- lobColumnNames / transferableColumns ----

check('lobColumnNames lists exactly the LOB columns, in order', () => {
  const columns = [col('id', 'integer'), col('avatar', 'bytea', { isLob: true }), col('name', 'text'), col('doc', 'blob', { isLob: true })]
  assertEqual(lobColumnNames(columns), ['avatar', 'doc'], 'lob names')
})

check('lobColumnNames of a LOB-free table is empty', () => {
  assertEqual(lobColumnNames([col('id', 'integer')]), [], 'empty')
})

check('transferableColumns drops LOB columns and keeps the rest in order', () => {
  const columns = [col('id', 'integer'), col('avatar', 'bytea', { isLob: true }), col('name', 'text')]
  assertEqual(transferableColumns(columns).map((c) => c.name), ['id', 'name'], 'lob removed')
})

// ---- buildTransferEdits ----

check('buildTransferEdits keys each value by column name and skips LOB columns', () => {
  const columns = [col('id', 'integer'), col('avatar', 'bytea', { isLob: true }), col('name', 'text')]
  const edits = buildTransferEdits(target, columns, [
    [1, 'BLOBDATA', 'Ada'],
    [2, 'BLOBDATA', 'Grace'],
  ])
  assertEqual(edits, [
    { object: target, kind: 'insert', newValues: { id: 1, name: 'Ada' } },
    { object: target, kind: 'insert', newValues: { id: 2, name: 'Grace' } },
  ], 'lob value never leaves the source')
})

check('buildTransferEdits preserves null (it is a value, not an omission)', () => {
  const columns = [col('id', 'integer'), col('name', 'text')]
  const edits = buildTransferEdits(target, columns, [[1, null]])
  assertEqual(edits[0].newValues, { id: 1, name: null }, 'null carried across')
})

check('buildTransferEdits omits a cell the source row does not have', () => {
  // A driver returning a short row must not fabricate `undefined`, which
  // JSON.stringify would drop from the body anyway and which would land in
  // the target as an unpredictable default.
  const columns = [col('id', 'integer'), col('name', 'text')]
  const edits = buildTransferEdits(target, columns, [[1]])
  assertEqual(edits[0].newValues, { id: 1 }, 'missing cell omitted, not undefined')
})

check('buildTransferEdits on zero rows returns no edits', () => {
  assertEqual(buildTransferEdits(target, [col('id', 'integer')], []), [], 'empty')
})

check('buildTransferEdits with an all-LOB table still emits one empty insert per row', () => {
  // The row exists in the source; dropping it silently would under-report the
  // transfer. An insert with no columns is the honest representation and the
  // server rejects it loudly if the engine cannot express it.
  const columns = [col('doc', 'blob', { isLob: true })]
  const edits = buildTransferEdits(target, columns, [['x'], ['y']])
  assertEqual(edits.length, 2, 'one edit per source row')
  assertEqual(edits[0].newValues, {}, 'no values')
})

// ---- nextPageRequest ----

const source: DBObjectRef = { database: 'src', schema: 'public', name: 'users', kind: 'table' }

check('nextPageRequest starts at a null cursor and offset 0', () => {
  const req = nextPageRequest(source, 500, null, 0, false)
  assertEqual(req.cursor, null, 'no cursor')
  assertEqual(req.offset, 0, 'offset 0')
  assertEqual(req.limit, 500, 'limit is the batch size')
  assertEqual(req.filters, [], 'a transfer copies the whole table, unfiltered')
  assertEqual(req.sort, [], 'no sort — the server picks its own stable key')
  assertEqual(req.globalSearch, '', 'no search')
})

check('nextPageRequest follows the cursor when the server gave one', () => {
  const req = nextPageRequest(source, 500, [42], 500, false)
  assertEqual(req.cursor, [42], 'cursor carried')
  assertEqual(req.offset, 0, 'offset is unused once a cursor exists')
})

check('nextPageRequest falls back to offset paging when the server used it', () => {
  // usedOffsetPaging means the table has no usable row identity, so the
  // cursor is meaningless and only the running row count can advance us.
  const req = nextPageRequest(source, 500, [42], 1000, true)
  assertEqual(req.cursor, null, 'cursor dropped')
  assertEqual(req.offset, 1000, 'offset is the rows already transferred')
})

// ---- rowsPerSecond ----

check('rowsPerSecond divides rows by elapsed seconds', () => {
  assertEqual(rowsPerSecond(5000, 2500), 2000, '5000 rows in 2.5s')
})

check('rowsPerSecond of a zero/negative elapsed is 0 rather than Infinity', () => {
  assertEqual(rowsPerSecond(5000, 0), 0, 'no division by zero')
  assertEqual(rowsPerSecond(5000, -10), 0, 'negative clock skew')
})

check('rowsPerSecond rounds to a whole number', () => {
  assertEqual(rowsPerSecond(10, 3000), 3, '3.33 -> 3')
})

console.log(`\n${passed} tests passed`)
