/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/exportClient.test.ts
 */

import { resultToCSV, resultToJSON } from './exportClient'
import { parseCSV } from './csv'
import type { DBColumnMeta, DBResultSet } from '@/lib/api'

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

function col(name: string, dataType = 'text'): DBColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    default: null,
    isPrimaryKey: false,
    ordinalPosition: 1,
    isLob: false,
    comparable: true,
  }
}

function rs(columns: string[], rows: unknown[][]): DBResultSet {
  return {
    columns: columns.map((c) => col(c)),
    rows,
    truncated: false,
    nextCursor: null,
    usedOffsetPaging: false,
    elapsedMs: 1,
  }
}

// ---- resultToCSV ----

check('resultToCSV writes a header row followed by data rows', () => {
  const out = resultToCSV(rs(['id', 'name'], [[1, 'Ada'], [2, 'Grace']]))
  assertEqual(out, 'id,name\n1,Ada\n2,Grace', 'plain result')
})

check('resultToCSV on an empty result set still emits the header row', () => {
  assertEqual(resultToCSV(rs(['id', 'name'], [])), 'id,name', 'header only')
})

check('resultToCSV on a result set with no columns emits an empty string', () => {
  assertEqual(resultToCSV(rs([], [])), '', 'nothing to write')
})

check('resultToCSV renders null as an empty (unquoted) field', () => {
  assertEqual(resultToCSV(rs(['a', 'b'], [[null, 'x']])), 'a,b\n,x', 'null is empty, distinguishable from ""')
})

check('resultToCSV renders undefined as an empty field too', () => {
  assertEqual(resultToCSV(rs(['a', 'b'], [[undefined, 'x']])), 'a,b\n,x', 'undefined')
})

check('resultToCSV quotes a field containing the delimiter', () => {
  assertEqual(resultToCSV(rs(['a'], [['x,y']])), 'a\n"x,y"', 'comma forces quoting')
})

check('resultToCSV quotes a field containing a quote and doubles the embedded quote', () => {
  assertEqual(resultToCSV(rs(['a'], [['she said "hi"']])), 'a\n"she said ""hi"""', 'RFC 4180 escaping')
})

check('resultToCSV quotes a field containing a newline or CR', () => {
  assertEqual(resultToCSV(rs(['a'], [['line1\nline2']])), 'a\n"line1\nline2"', 'LF forces quoting')
  assertEqual(resultToCSV(rs(['a'], [['line1\r\nline2']])), 'a\n"line1\r\nline2"', 'CRLF forces quoting')
})

check('resultToCSV leaves an ordinary field unquoted', () => {
  assertEqual(resultToCSV(rs(['a'], [['plain value']])), 'a\nplain value', 'spaces alone do not force quoting')
})

check('resultToCSV quotes a column name that needs it', () => {
  assertEqual(resultToCSV(rs(['full,name'], [['Ada']])), '"full,name"\nAda', 'header quoted too')
})

check('resultToCSV renders booleans and numbers via their string form', () => {
  assertEqual(resultToCSV(rs(['n', 'b'], [[42, true], [-1.5, false]])), 'n,b\n42,true\n-1.5,false', 'primitives')
})

check('resultToCSV JSON-stringifies object and array values', () => {
  assertEqual(resultToCSV(rs(['j'], [[{ k: 1 }]])), 'j\n"{""k"":1}"', 'object stringified then quoted')
  assertEqual(resultToCSV(rs(['j'], [[[1, 2]]])), 'j\n"[1,2]"', 'array stringified then quoted')
})

check('resultToCSV pads a short row so the column count always matches the header', () => {
  assertEqual(resultToCSV(rs(['a', 'b', 'c'], [[1]])), 'a,b,c\n1,,', 'missing cells become empty fields')
})

check('resultToCSV output round-trips through parseCSV', () => {
  const source = rs(['id', 'note'], [
    [1, 'plain'],
    [2, 'has,comma'],
    [3, 'has "quote"'],
    [4, 'has\nnewline'],
    [5, null],
  ])
  const parsed = parseCSV(resultToCSV(source))
  assertEqual(parsed.errors, [], 'the emitted CSV parses without ragged rows')
  assertEqual(parsed.headers, ['id', 'note'], 'headers survive')
  assertEqual(parsed.rows, [
    ['1', 'plain'],
    ['2', 'has,comma'],
    ['3', 'has "quote"'],
    ['4', 'has\nnewline'],
    ['5', ''],
  ], 'every value survives the round trip')
})

// ---- resultToJSON ----

check('resultToJSON emits an array of objects keyed by column name', () => {
  const out = resultToJSON(rs(['id', 'name'], [[1, 'Ada'], [2, 'Grace']]))
  assertEqual(JSON.parse(out), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], 'parsed shape')
})

check('resultToJSON is pretty-printed with 2 spaces', () => {
  const out = resultToJSON(rs(['id'], [[1]]))
  assertEqual(out, '[\n  {\n    "id": 1\n  }\n]', 'exact formatting')
})

check('resultToJSON preserves null rather than dropping the key', () => {
  const out = resultToJSON(rs(['a', 'b'], [[null, 'x']]))
  assertEqual(out.includes('"a": null'), true, 'null present in the text')
  assertEqual(JSON.parse(out), [{ a: null, b: 'x' }], 'null preserved')
})

check('resultToJSON normalizes undefined to null so the key is never dropped', () => {
  const out = resultToJSON(rs(['a', 'b'], [[undefined, 'x']]))
  assertEqual(JSON.parse(out), [{ a: null, b: 'x' }], 'undefined becomes null')
})

check('resultToJSON keeps numbers, booleans and nested objects as JSON values, not strings', () => {
  const out = resultToJSON(rs(['n', 'b', 'j'], [[42, true, { k: [1, 2] }]]))
  assertEqual(JSON.parse(out), [{ n: 42, b: true, j: { k: [1, 2] } }], 'native types preserved')
})

check('resultToJSON on an empty result set emits an empty array', () => {
  assertEqual(resultToJSON(rs(['id'], [])), '[]', 'empty array')
})

check('resultToJSON fills a short row with nulls for the missing columns', () => {
  assertEqual(JSON.parse(resultToJSON(rs(['a', 'b'], [[1]]))), [{ a: 1, b: null }], 'missing cell is null')
})

check('resultToJSON ignores extra cells beyond the declared columns', () => {
  assertEqual(JSON.parse(resultToJSON(rs(['a'], [[1, 'extra']]))), [{ a: 1 }], 'only declared columns are emitted')
})

check('resultToJSON with duplicate column names keeps the last value (JS object semantics)', () => {
  assertEqual(JSON.parse(resultToJSON(rs(['a', 'a'], [[1, 2]]))), [{ a: 2 }], 'documented collapse')
})

console.log(`\n${passed} tests passed`)
