/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/importMap.test.ts
 */

import { autoMapColumns, buildInsertEdits, chunk, classifyTypeFamily, coerceValue } from './importMap'
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

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(`assertion failed: ${message}`)
}

const OBJ: DBObjectRef = { database: 'app', schema: 'public', name: 'users', kind: 'table' }

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

// ---- classifyTypeFamily ----

check('classifier: postgres integer type names', () => {
  for (const t of ['integer', 'int', 'int4', 'int8', 'bigint', 'smallint', 'serial', 'bigserial', 'smallint']) {
    assertEqual(classifyTypeFamily(t), 'integer', `${t} -> integer`)
  }
})

check('classifier: mysql / sqlite integer type names', () => {
  for (const t of ['INTEGER', 'tinyint', 'mediumint', 'int(11)', 'bigint unsigned', 'INT UNSIGNED']) {
    assertEqual(classifyTypeFamily(t), 'integer', `${t} -> integer`)
  }
})

check('classifier: float family across engines', () => {
  for (const t of ['real', 'REAL', 'double precision', 'double', 'float', 'numeric', 'numeric(10,2)', 'decimal(8,3)', 'DECIMAL']) {
    assertEqual(classifyTypeFamily(t), 'float', `${t} -> float`)
  }
})

check('classifier: boolean family across engines', () => {
  for (const t of ['boolean', 'bool', 'BOOLEAN', 'tinyint(1)']) {
    assertEqual(classifyTypeFamily(t), 'boolean', `${t} -> boolean`)
  }
})

check('classifier: everything else is text', () => {
  for (const t of ['text', 'varchar(255)', 'character varying', 'uuid', 'json', 'jsonb', 'timestamptz', 'date', 'bytea', 'longblob', 'enum(\'a\',\'b\')', '']) {
    assertEqual(classifyTypeFamily(t), 'text', `${t} -> text`)
  }
})

check('classifier: "point" is not an integer despite containing "int"', () => {
  assertEqual(classifyTypeFamily('point'), 'text', 'postgres geometric type')
})

// ---- autoMapColumns ----

check('autoMapColumns maps exact header/column name matches', () => {
  const m = autoMapColumns(['id', 'name'], [col('id', 'int'), col('name', 'text')])
  assertEqual(m, { id: 'id', name: 'name' }, 'exact')
})

check('autoMapColumns matches case-insensitively', () => {
  const m = autoMapColumns(['ID', 'Name'], [col('id', 'int'), col('name', 'text')])
  assertEqual(m, { ID: 'id', Name: 'name' }, 'case folded')
})

check('autoMapColumns treats underscores, dashes and spaces as equivalent', () => {
  const cols = [col('first_name', 'text'), col('last_name', 'text'), col('email_address', 'text')]
  assertEqual(autoMapColumns(['First Name', 'last-name', 'Email_Address'], cols), {
    'First Name': 'first_name',
    'last-name': 'last_name',
    Email_Address: 'email_address',
  }, 'separators normalized')
})

check('autoMapColumns yields null for a header with no matching column', () => {
  const m = autoMapColumns(['id', 'nickname'], [col('id', 'int')])
  assertEqual(m, { id: 'id', nickname: null }, 'unmatched header skipped')
})

check('autoMapColumns never maps two headers to the same column', () => {
  const m = autoMapColumns(['first name', 'first_name'], [col('first_name', 'text')])
  assertEqual(m, { 'first name': 'first_name', first_name: null }, 'first header wins, second is skipped')
})

check('autoMapColumns returns an entry for every header, including duplicates collapsing to one key', () => {
  const m = autoMapColumns([], [col('id', 'int')])
  assertEqual(m, {}, 'no headers, no entries')
})

// ---- coerceValue: null / empty handling ----

check('empty string becomes null for a nullable column', () => {
  assertEqual(coerceValue('', col('age', 'integer', { nullable: true })), { ok: true, value: null }, 'nullable int')
  assertEqual(coerceValue('', col('bio', 'text', { nullable: true })), { ok: true, value: null }, 'nullable text')
})

check('empty string on a NOT NULL text column becomes an empty string, not an error', () => {
  assertEqual(coerceValue('', col('bio', 'text', { nullable: false })), { ok: true, value: '' }, 'not-null text')
})

check('empty string on a NOT NULL non-text column is an error', () => {
  const r = coerceValue('', col('age', 'integer', { nullable: false }))
  assertEqual(r.ok, false, 'rejected')
  assert(!r.ok && r.error.length > 0, 'carries a message')
})

// ---- coerceValue: integers ----

check('integers parse strictly', () => {
  assertEqual(coerceValue('42', col('n', 'integer')), { ok: true, value: 42 }, 'plain')
  assertEqual(coerceValue('-7', col('n', 'bigint')), { ok: true, value: -7 }, 'negative')
  assertEqual(coerceValue('  12  ', col('n', 'int4')), { ok: true, value: 12 }, 'surrounding whitespace trimmed')
  assertEqual(coerceValue('+3', col('n', 'int')), { ok: true, value: 3 }, 'explicit plus')
})

check('integer parsing rejects trailing garbage rather than truncating it', () => {
  assertEqual(coerceValue('12abc', col('n', 'integer')).ok, false, '12abc rejected (parseInt would give 12)')
  assertEqual(coerceValue('1.5', col('n', 'integer')).ok, false, 'a decimal is not an integer')
  assertEqual(coerceValue('abc', col('n', 'integer')).ok, false, 'letters')
  assertEqual(coerceValue('1e3', col('n', 'integer')).ok, false, 'exponent notation')
})

// ---- coerceValue: floats ----

check('float / numeric parse via Number', () => {
  assertEqual(coerceValue('1.5', col('x', 'numeric(10,2)')), { ok: true, value: 1.5 }, 'decimal')
  assertEqual(coerceValue('-0.25', col('x', 'double precision')), { ok: true, value: -0.25 }, 'negative')
  assertEqual(coerceValue('1e3', col('x', 'real')), { ok: true, value: 1000 }, 'exponent allowed for floats')
  assertEqual(coerceValue('7', col('x', 'decimal')), { ok: true, value: 7 }, 'integral literal')
})

check('float parsing rejects NaN-producing input', () => {
  assertEqual(coerceValue('abc', col('x', 'numeric')).ok, false, 'letters')
  assertEqual(coerceValue('1.2.3', col('x', 'float')).ok, false, 'malformed')
  assertEqual(coerceValue('NaN', col('x', 'double')).ok, false, 'literal NaN string is rejected')
})

// ---- coerceValue: booleans ----

check('boolean accepts true/false/t/f/1/0/yes/no case-insensitively', () => {
  const b = col('flag', 'boolean')
  for (const s of ['true', 'TRUE', 'True', 't', 'T', '1', 'yes', 'YES', 'Y', 'y']) {
    assertEqual(coerceValue(s, b), { ok: true, value: true }, `${s} -> true`)
  }
  for (const s of ['false', 'FALSE', 'False', 'f', 'F', '0', 'no', 'NO', 'N', 'n']) {
    assertEqual(coerceValue(s, b), { ok: true, value: false }, `${s} -> false`)
  }
})

check('boolean rejects anything else', () => {
  assertEqual(coerceValue('maybe', col('flag', 'boolean')).ok, false, 'maybe')
  assertEqual(coerceValue('2', col('flag', 'tinyint(1)')).ok, false, '2 is not a boolean')
})

// ---- coerceValue: pass-through ----

check('text, dates, json and uuid pass through as the raw string', () => {
  assertEqual(coerceValue('hello', col('a', 'text')), { ok: true, value: 'hello' }, 'text')
  assertEqual(coerceValue('2024-01-15', col('a', 'date')), { ok: true, value: '2024-01-15' }, 'date')
  assertEqual(coerceValue('2024-01-15T10:00:00Z', col('a', 'timestamptz')), { ok: true, value: '2024-01-15T10:00:00Z' }, 'timestamp')
  assertEqual(coerceValue('{"k":1}', col('a', 'jsonb')), { ok: true, value: '{"k":1}' }, 'json is not re-encoded')
  assertEqual(coerceValue('550e8400-e29b-41d4-a716-446655440000', col('a', 'uuid')), { ok: true, value: '550e8400-e29b-41d4-a716-446655440000' }, 'uuid')
})

check('pass-through preserves surrounding whitespace verbatim', () => {
  assertEqual(coerceValue('  pad  ', col('a', 'text')), { ok: true, value: '  pad  ' }, 'text is not trimmed')
})

// ---- buildInsertEdits ----

const COLS = [
  col('id', 'integer', { nullable: false, isPrimaryKey: true, ordinalPosition: 1 }),
  col('name', 'text', { nullable: false, ordinalPosition: 2 }),
  col('active', 'boolean', { ordinalPosition: 3 }),
]

check('buildInsertEdits produces one insert edit per row keyed by target column', () => {
  const r = buildInsertEdits(
    OBJ,
    { csv_id: 'id', csv_name: 'name', csv_active: 'active' },
    ['csv_id', 'csv_name', 'csv_active'],
    [['1', 'Ada', 'true'], ['2', 'Grace', 'false']],
    COLS,
  )
  assertEqual(r.errors, [], 'no errors')
  assertEqual(r.edits.length, 2, 'two edits')
  assertEqual(r.edits[0].kind, 'insert', 'kind')
  assertEqual(r.edits[0].object, OBJ, 'object threaded through')
  assertEqual(r.edits[0].newValues, { id: 1, name: 'Ada', active: true }, 'coerced values keyed by column')
  assertEqual(r.edits[1].newValues, { id: 2, name: 'Grace', active: false }, 'second row')
})

check('buildInsertEdits skips headers mapped to null', () => {
  const r = buildInsertEdits(
    OBJ,
    { csv_id: 'id', junk: null, csv_name: 'name' },
    ['csv_id', 'junk', 'csv_name'],
    [['1', 'ignore me', 'Ada']],
    COLS,
  )
  assertEqual(r.edits[0].newValues, { id: 1, name: 'Ada' }, 'unmapped column absent from newValues')
})

check('buildInsertEdits reports a coercion error with a 1-based row number and the target column', () => {
  const r = buildInsertEdits(
    OBJ,
    { csv_id: 'id', csv_name: 'name' },
    ['csv_id', 'csv_name'],
    [['1', 'Ada'], ['oops', 'Grace']],
    COLS,
  )
  assertEqual(r.errors.length, 1, 'one error')
  assertEqual(r.errors[0].row, 2, '1-based data row')
  assertEqual(r.errors[0].column, 'id', 'target column name, not the csv header')
  assert(r.errors[0].message.length > 0, 'has a message')
})

check('buildInsertEdits emits no edit for a row that has any error', () => {
  const r = buildInsertEdits(
    OBJ,
    { csv_id: 'id', csv_name: 'name' },
    ['csv_id', 'csv_name'],
    [['1', 'Ada'], ['oops', 'Grace'], ['3', 'Hopper']],
    COLS,
  )
  assertEqual(r.edits.length, 2, 'the bad row is dropped, the good ones survive')
  assertEqual(r.edits.map((e) => e.newValues?.id), [1, 3], 'rows 1 and 3 kept')
})

check('buildInsertEdits collects every bad cell in a row, not just the first', () => {
  const cols = [col('id', 'integer'), col('score', 'numeric')]
  const r = buildInsertEdits(
    OBJ,
    { a: 'id', b: 'score' },
    ['a', 'b'],
    [['bad', 'worse']],
    cols,
  )
  assertEqual(r.errors.length, 2, 'both cells reported')
  assertEqual(r.errors.map((e) => e.column), ['id', 'score'], 'both columns named')
  assertEqual(r.edits.length, 0, 'no edit emitted')
})

check('buildInsertEdits treats a missing cell in a short row as an empty string', () => {
  const cols = [col('id', 'integer'), col('note', 'text', { nullable: true })]
  const r = buildInsertEdits(OBJ, { a: 'id', b: 'note' }, ['a', 'b'], [['1']], cols)
  assertEqual(r.errors, [], 'no error - a missing nullable cell is null')
  assertEqual(r.edits[0].newValues, { id: 1, note: null }, 'null for the absent cell')
})

check('buildInsertEdits errors when a header maps to a column that is not in the table', () => {
  const r = buildInsertEdits(OBJ, { a: 'nope' }, ['a'], [['x']], COLS)
  assertEqual(r.edits.length, 0, 'no edit')
  assertEqual(r.errors[0].column, 'nope', 'names the unknown column')
})

check('buildInsertEdits on zero rows returns empty edits and errors', () => {
  const r = buildInsertEdits(OBJ, { a: 'id' }, ['a'], [], COLS)
  assertEqual(r, { edits: [], errors: [] }, 'empty')
})

// ---- chunk ----

check('chunk splits evenly and keeps a short final chunk', () => {
  assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'remainder kept')
  assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]], 'even split')
})

check('chunk handles an empty list and an oversized size', () => {
  assertEqual(chunk([], 10), [], 'empty')
  assertEqual(chunk([1, 2], 10), [[1, 2]], 'one chunk when size exceeds length')
})

check('chunk with a non-positive size returns a single chunk rather than looping forever', () => {
  assertEqual(chunk([1, 2, 3], 0), [[1, 2, 3]], 'size 0')
  assertEqual(chunk([1, 2, 3], -5), [[1, 2, 3]], 'negative size')
})

console.log(`\n${passed} tests passed`)
