/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's convention
 * (no Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/features/terminal/fileMatchHighlight.test.ts
 */

import { computeHighlight, type HighlightRange } from './fileMatchHighlight'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertRanges(actual: HighlightRange[], expected: HighlightRange[], message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

check('empty query highlights nothing', () => {
  assertRanges(computeHighlight('useScope.ts', ''), [], 'empty query')
  assertRanges(computeHighlight('useScope.ts', '   '), [], 'whitespace-only query')
})

check('empty text highlights nothing', () => {
  assertRanges(computeHighlight('', 'feature'), [], 'empty text')
})

check('substring match in a basename', () => {
  assertRanges(computeHighlight('useScope.ts', 'scope'), [[3, 8]], 'scope in useScope.ts')
})

check('substring match in a folder path', () => {
  assertRanges(computeHighlight('frontend/src/features', 'feature'), [[13, 20]], 'feature in features')
})

check('matching is case-insensitive', () => {
  assertRanges(computeHighlight('Header.tsx', 'header'), [[0, 6]], 'Header vs header')
})

check('every occurrence of a token is highlighted', () => {
  // "s" appears at indices 9 and 20 (…/src… and …feature[s]).
  assertRanges(computeHighlight('frontend/src/features', 's'), [[9, 10], [20, 21]], 'both s')
})

check('multiple whitespace tokens each highlight', () => {
  assertRanges(
    computeHighlight('frontend/src/features/tabs', 'src tabs'),
    [[9, 12], [22, 26]],
    'src and tabs',
  )
})

check('fuzzy subsequence fallback highlights matched chars', () => {
  // "usc" is not a substring of "usescope.ts"; matches u(0) s(1) c(4).
  assertRanges(computeHighlight('useScope.ts', 'usc'), [[0, 2], [4, 5]], 'usc subsequence')
})

check('incomplete subsequence highlights nothing', () => {
  assertRanges(computeHighlight('foo/bar.ts', 'xyz'), [], 'no x/y/z')
})

check('regex-looking query skips highlighting', () => {
  assertRanges(computeHighlight('src/app.ts', 'app.*'), [], 'regex meta chars')
})

check('adjacent hits merge into one span', () => {
  // Two tokens "fea" + "ture" both substring-hit and abut → single [13,20].
  assertRanges(computeHighlight('frontend/src/features', 'fea ture'), [[13, 20]], 'merged span')
})

console.log(`\n${passed} passed`)
