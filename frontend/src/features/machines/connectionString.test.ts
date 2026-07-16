/**
 * Plain assertion-based tests for connectionString.ts.
 *
 * No test runner (Vitest/Jest) is configured in this frontend project, so
 * this is a standalone script: every `check()` call throws on failure,
 * `main()` runs them all and prints a pass count. Run manually with:
 *
 *   npx tsx src/features/machines/connectionString.test.ts
 */

import { parseConnectionString } from './connectionString'

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

check('parses a well-formed connection string', () => {
  const result = parseConnectionString('builder|https://builder.tail-x.ts.net|abc123')
  assertEqual(result, { name: 'builder', url: 'https://builder.tail-x.ts.net', key: 'abc123' }, 'parsed fields')
})

check('trims surrounding whitespace and newlines from a pasted string', () => {
  const result = parseConnectionString('  builder|https://x.ts.net|abc123\n')
  assertEqual(result, { name: 'builder', url: 'https://x.ts.net', key: 'abc123' }, 'trimmed fields')
})

check('rejects too few fields', () => {
  assertEqual(parseConnectionString('builder|https://x.ts.net'), null, 'two fields')
})

check('rejects too many fields', () => {
  assertEqual(parseConnectionString('a|b|c|d'), null, 'four fields')
})

check('rejects an empty field', () => {
  assertEqual(parseConnectionString('builder||abc123'), null, 'empty url field')
})

check('rejects a non-http(s) url', () => {
  assertEqual(parseConnectionString('builder|ftp://x.ts.net|abc123'), null, 'ftp url')
})

check('rejects an empty string', () => {
  assertEqual(parseConnectionString(''), null, 'empty input')
})

function main() {
  console.log(`\n${passed} passed`)
}

main()
