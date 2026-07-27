/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/lib/contentDisposition.test.ts
 *
 * The Go side (backend/internal/handler/content_disposition.go) always emits
 * BOTH `filename="ascii"` and `filename*=UTF-8''pct-encoded`, and RFC 6266
 * §4.3 says a client that understands `filename*` must prefer it. These tests
 * pin that preference — reading the lossy ASCII fallback instead would turn
 * every non-ASCII table name into underscores in the saved file.
 */

import { parseContentDispositionFilename } from './contentDisposition'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

const FALLBACK = 'export.csv'

check('a missing header falls back', () => {
  assertEqual(parseContentDispositionFilename(null, FALLBACK), FALLBACK, 'null header')
  assertEqual(parseContentDispositionFilename('', FALLBACK), FALLBACK, 'empty header')
})

check('a header with no filename parameter falls back', () => {
  assertEqual(parseContentDispositionFilename('attachment', FALLBACK), FALLBACK, 'bare attachment')
})

check('reads a quoted filename', () => {
  assertEqual(parseContentDispositionFilename('attachment; filename="users.csv"', FALLBACK), 'users.csv', 'quoted')
})

check('reads an unquoted filename token', () => {
  assertEqual(parseContentDispositionFilename('attachment; filename=users.csv', FALLBACK), 'users.csv', 'token')
})

check('an unquoted token stops at the next parameter', () => {
  assertEqual(
    parseContentDispositionFilename('attachment; filename=users.csv; size=10', FALLBACK),
    'users.csv',
    'token stops at ;',
  )
})

check('filename* wins over filename (RFC 6266 §4.3)', () => {
  // What the Go handler actually sends for a table named "ünïcode".
  const header = `attachment; filename="_n_code.csv"; filename*=UTF-8''%C3%BCn%C3%AFcode.csv`
  assertEqual(parseContentDispositionFilename(header, FALLBACK), 'ünïcode.csv', 'extended form preferred')
})

check('filename* is percent-decoded including spaces', () => {
  const header = `attachment; filename="my table.csv"; filename*=UTF-8''my%20table.csv`
  assertEqual(parseContentDispositionFilename(header, FALLBACK), 'my table.csv', 'decoded spaces')
})

check('filename* with a language tag is still read', () => {
  assertEqual(
    parseContentDispositionFilename(`attachment; filename*=UTF-8'en'report.csv`, FALLBACK),
    'report.csv',
    'language tag',
  )
})

check('a malformed percent-escape in filename* falls back to the plain filename', () => {
  // decodeURIComponent throws on a lone "%"; we must not propagate that.
  const header = `attachment; filename="safe.csv"; filename*=UTF-8''bad%zz.csv`
  assertEqual(parseContentDispositionFilename(header, FALLBACK), 'safe.csv', 'bad escape')
})

check('a malformed filename* with no plain filename falls back to the default', () => {
  assertEqual(parseContentDispositionFilename(`attachment; filename*=UTF-8''%`, FALLBACK), FALLBACK, 'bad escape only')
})

check('escaped quotes inside a quoted-string are unescaped', () => {
  assertEqual(
    parseContentDispositionFilename('attachment; filename="wei\\"rd.csv"', FALLBACK),
    'wei"rd.csv',
    'escaped quote',
  )
})

check('path separators are stripped so the name cannot escape the download dir', () => {
  assertEqual(
    parseContentDispositionFilename(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`, FALLBACK),
    'passwd',
    'posix separators',
  )
  assertEqual(
    parseContentDispositionFilename('attachment; filename="C:\\\\temp\\\\x.csv"', FALLBACK),
    'x.csv',
    'windows separators',
  )
})

check('a name that sanitizes to nothing falls back', () => {
  assertEqual(parseContentDispositionFilename('attachment; filename="/"', FALLBACK), FALLBACK, 'slash only')
  assertEqual(parseContentDispositionFilename('attachment; filename=""', FALLBACK), FALLBACK, 'empty quoted')
  assertEqual(parseContentDispositionFilename('attachment; filename="  "', FALLBACK), FALLBACK, 'blank')
})

check('the parameter name match is case-insensitive', () => {
  assertEqual(parseContentDispositionFilename('attachment; FileName="users.csv"', FALLBACK), 'users.csv', 'mixed case')
})

console.log(`\n${passed} tests passed`)
