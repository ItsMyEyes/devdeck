import { displayUrl } from './displayUrl'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}
function assertEqual(actual: string, expected: string, message: string) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

check('strips scheme and a bare trailing slash', () => {
  assertEqual(displayUrl('https://example.com/'), 'example.com', 'bare trailing slash root')
})

check('keeps a non-root path without a trailing slash', () => {
  assertEqual(displayUrl('https://example.com/dashboard/'), 'example.com/dashboard', 'trailing slash stripped from a path')
})

check('keeps the query string', () => {
  assertEqual(displayUrl('https://example.com/search?q=x'), 'example.com/search?q=x', 'query preserved')
})

check('an empty url reads as New Tab', () => {
  assertEqual(displayUrl(''), 'New Tab', 'empty url')
})

check('an unparseable string is returned as-is', () => {
  assertEqual(displayUrl('not a url'), 'not a url', 'unparseable input unchanged')
})

console.log(`\n${passed} tests passed`)
