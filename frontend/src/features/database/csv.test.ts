/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/csv.test.ts
 */

import { detectDelimiter, parseCSV } from './csv'

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

// ---- basic shape ----

check('parses a plain comma file into headers + rows with no errors', () => {
  const r = parseCSV('id,name,email\n1,Ada,ada@example.com\n2,Grace,grace@example.com')
  assertEqual(r.headers, ['id', 'name', 'email'], 'headers')
  assertEqual(r.rows, [
    ['1', 'Ada', 'ada@example.com'],
    ['2', 'Grace', 'grace@example.com'],
  ], 'rows')
  assertEqual(r.errors, [], 'no errors')
})

check('empty input yields empty headers, rows and errors', () => {
  const r = parseCSV('')
  assertEqual(r.headers, [], 'headers')
  assertEqual(r.rows, [], 'rows')
  assertEqual(r.errors, [], 'errors')
})

check('a header-only file yields headers and zero rows', () => {
  const r = parseCSV('a,b,c\n')
  assertEqual(r.headers, ['a', 'b', 'c'], 'headers')
  assertEqual(r.rows, [], 'no data rows')
})

// ---- quoting (RFC 4180) ----

check('quoted field keeps an embedded delimiter', () => {
  const r = parseCSV('a,b\n"x,y",z')
  assertEqual(r.rows, [['x,y', 'z']], 'comma inside quotes is data, not a separator')
})

check('doubled quotes inside a quoted field collapse to one literal quote', () => {
  const r = parseCSV('a\n"she said ""hi"""')
  assertEqual(r.rows, [['she said "hi"']], 'escaped quotes')
})

check('a quoted field may contain an embedded newline', () => {
  const r = parseCSV('a,b\n"line1\nline2",z')
  assertEqual(r.rows, [['line1\nline2', 'z']], 'newline preserved inside quotes')
  assertEqual(r.errors, [], 'the embedded newline does not start a new record')
})

check('a CRLF inside a quoted field is normalized to a single LF', () => {
  const r = parseCSV('a,b\r\n"line1\r\nline2",z\r\n')
  assertEqual(r.rows, [['line1\nline2', 'z']], 'CRLF normalized inside quotes')
})

check('an empty quoted field parses to an empty string', () => {
  const r = parseCSV('a,b\n"",x')
  assertEqual(r.rows, [['', 'x']], 'empty quoted field')
})

check('a bare quote in the middle of an unquoted field is kept literally', () => {
  const r = parseCSV('a\n5" pipe')
  assertEqual(r.rows, [['5" pipe']], 'literal quote in unquoted field')
})

check('whitespace around a quoted field boundary is preserved verbatim', () => {
  const r = parseCSV('a,b\n"pad" ,z')
  assertEqual(r.rows, [['pad ', 'z']], 'trailing space after closing quote stays in the field')
})

// ---- line endings / trailing newline / BOM ----

check('CRLF line endings parse the same as LF', () => {
  const r = parseCSV('a,b\r\n1,2\r\n3,4')
  assertEqual(r.headers, ['a', 'b'], 'headers have no stray CR')
  assertEqual(r.rows, [['1', '2'], ['3', '4']], 'rows')
})

check('a trailing newline does not produce a phantom empty row', () => {
  assertEqual(parseCSV('a,b\n1,2\n').rows, [['1', '2']], 'LF trailing')
  assertEqual(parseCSV('a,b\r\n1,2\r\n').rows, [['1', '2']], 'CRLF trailing')
})

check('a UTF-8 BOM is stripped from the first header', () => {
  const r = parseCSV('﻿id,name\n1,Ada')
  assertEqual(r.headers, ['id', 'name'], 'first header has no BOM')
  assertEqual(r.errors, [], 'no errors')
})

check('a blank line between records is skipped, but a quoted empty line is a real row', () => {
  assertEqual(parseCSV('a,b\n1,2\n\n3,4\n').rows, [['1', '2'], ['3', '4']], 'blank line skipped')
  assertEqual(parseCSV('a,b\n1,2\n\n3,4\n').errors, [], 'a skipped blank line is not a ragged row')
  assertEqual(parseCSV('a\n1\n""\n').rows, [['1'], ['']], 'an explicitly quoted empty record is kept')
})

// ---- delimiters ----

check('semicolon delimiter', () => {
  const r = parseCSV('a;b\n1;2', { delimiter: ';' })
  assertEqual(r.headers, ['a', 'b'], 'headers')
  assertEqual(r.rows, [['1', '2']], 'rows')
})

check('tab delimiter', () => {
  const r = parseCSV('a\tb\n1\t2', { delimiter: '\t' })
  assertEqual(r.headers, ['a', 'b'], 'headers')
  assertEqual(r.rows, [['1', '2']], 'rows')
})

check('with a non-comma delimiter, commas are ordinary characters', () => {
  const r = parseCSV('a;b\n1,5;2', { delimiter: ';' })
  assertEqual(r.rows, [['1,5', '2']], 'comma is data under a semicolon delimiter')
})

// ---- hasHeader:false ----

check('hasHeader false generates column_1..column_n and keeps every record as data', () => {
  const r = parseCSV('1,Ada\n2,Grace', { hasHeader: false })
  assertEqual(r.headers, ['column_1', 'column_2'], 'generated headers')
  assertEqual(r.rows, [['1', 'Ada'], ['2', 'Grace']], 'no record consumed as a header')
  assertEqual(r.errors, [], 'no errors')
})

check('hasHeader false widths come from the first record', () => {
  const r = parseCSV('1,2,3\n4,5', { hasHeader: false })
  assertEqual(r.headers, ['column_1', 'column_2', 'column_3'], 'three generated headers')
  assertEqual(r.errors, [{ row: 2, message: 'expected 3 fields, got 2' }], 'second record is ragged')
})

// ---- ragged rows ----

check('a short row is reported with a 1-based data row number and kept unpadded', () => {
  const r = parseCSV('a,b,c\n1,2,3\n4,5')
  assertEqual(r.rows, [['1', '2', '3'], ['4', '5']], 'the short row is kept raw, not padded')
  assertEqual(r.errors, [{ row: 2, message: 'expected 3 fields, got 2' }], 'error on data row 2')
})

check('a long row is reported and kept untruncated', () => {
  const r = parseCSV('a,b\n1,2,3')
  assertEqual(r.rows, [['1', '2', '3']], 'extra field kept')
  assertEqual(r.errors, [{ row: 1, message: 'expected 2 fields, got 3' }], 'error on data row 1')
})

check('every ragged row gets its own error, numbered independently of good rows', () => {
  const r = parseCSV('a,b\n1,2\n3\n4,5\n6,7,8')
  assertEqual(r.rows.length, 4, 'all four data rows returned')
  assertEqual(r.errors, [
    { row: 2, message: 'expected 2 fields, got 1' },
    { row: 4, message: 'expected 2 fields, got 3' },
  ], 'errors reference data rows 2 and 4')
})

// ---- detectDelimiter ----

check('detectDelimiter picks comma for a comma file', () => {
  assertEqual(detectDelimiter('id,name,email\n1,Ada,a@x.com\n2,Grace,g@x.com'), ',', 'comma')
})

check('detectDelimiter picks semicolon for a semicolon file', () => {
  assertEqual(detectDelimiter('id;name;email\n1;Ada;a@x.com\n2;Grace;g@x.com'), ';', 'semicolon')
})

check('detectDelimiter picks tab for a TSV', () => {
  assertEqual(detectDelimiter('id\tname\temail\n1\tAda\ta@x.com'), '\t', 'tab')
})

check('detectDelimiter prefers the delimiter with a consistent field count, not the most frequent character', () => {
  // Every line has more commas than semicolons, but only the semicolon
  // split is consistent (2 fields on every line).
  const sample = 'name;note\nAda;a,b,c,d\nGrace;e,f,g'
  assertEqual(detectDelimiter(sample), ';', 'semicolon is the consistent one')
})

check('detectDelimiter respects quoting when counting fields', () => {
  const sample = 'name;desc\n"a";"x,y,z,w"\n"b";"p,q,r,s"'
  assertEqual(detectDelimiter(sample), ';', 'commas inside quotes do not vote for comma')
})

check('detectDelimiter defaults to comma for a single-column / undetectable sample', () => {
  assertEqual(detectDelimiter('name\nAda\nGrace'), ',', 'fallback')
  assertEqual(detectDelimiter(''), ',', 'empty sample')
})

check('detectDelimiter only considers the first 10 lines', () => {
  const head = Array.from({ length: 10 }, (_, i) => `a${i};b${i}`).join('\n')
  const tail = Array.from({ length: 50 }, (_, i) => `x${i},y${i},z${i}`).join('\n')
  assertEqual(detectDelimiter(`${head}\n${tail}`), ';', 'later lines are ignored')
})

check('detectDelimiter result feeds straight back into parseCSV', () => {
  const sample = 'id;name\n1;Ada\n2;Grace'
  const r = parseCSV(sample, { delimiter: detectDelimiter(sample) })
  assertEqual(r.headers, ['id', 'name'], 'headers')
  assertEqual(r.rows, [['1', 'Ada'], ['2', 'Grace']], 'rows')
  assertEqual(r.errors, [], 'no errors')
})

console.log(`\n${passed} tests passed`)
