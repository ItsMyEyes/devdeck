/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's convention
 * (no Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/features/terminal/archiveName.test.ts
 */

import { archiveDefaultName, normalizeArchiveName } from './archiveName'
import type { SelectedEntry } from './fileTreeSelection'

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

check('appends .zip when absent', () => {
  assertEqual(normalizeArchiveName('report'), 'report.zip', 'plain name')
  assertEqual(normalizeArchiveName('report.tar'), 'report.tar.zip', 'other extension is kept, .zip appended')
})

check('leaves an existing .zip alone, case-insensitively', () => {
  assertEqual(normalizeArchiveName('report.zip'), 'report.zip', 'lowercase')
  assertEqual(normalizeArchiveName('report.ZIP'), 'report.ZIP', 'uppercase')
  assertEqual(normalizeArchiveName('report.Zip'), 'report.Zip', 'mixed case')
})

check('trims surrounding whitespace', () => {
  assertEqual(normalizeArchiveName('  report  '), 'report.zip', 'both sides')
  assertEqual(normalizeArchiveName('\treport.zip\n'), 'report.zip', 'tabs and newlines')
})

check('strips path separators so the name stays a single file', () => {
  assertEqual(normalizeArchiveName('src/features/report'), 'srcfeaturesreport.zip', 'forward slashes')
  assertEqual(normalizeArchiveName('..\\..\\etc\\passwd'), '....etcpasswd.zip', 'backslashes')
  assertEqual(normalizeArchiveName('/report.zip'), 'report.zip', 'leading slash')
  assertEqual(normalizeArchiveName('report/'), 'report.zip', 'trailing slash')
})

check('trims whitespace exposed by stripping separators', () => {
  assertEqual(normalizeArchiveName(' / report / '), 'report.zip', 'spaces around a separator')
})

check('falls back to selection.zip for empty input', () => {
  assertEqual(normalizeArchiveName(''), 'selection.zip', 'empty string')
  assertEqual(normalizeArchiveName('   '), 'selection.zip', 'whitespace only')
  assertEqual(normalizeArchiveName('///'), 'selection.zip', 'separators only')
})

const FILE: SelectedEntry = { name: 'notes.md', path: 'docs/notes.md', isDir: false }
const DIR: SelectedEntry = { name: 'docs', path: 'docs', isDir: true }

check('archiveDefaultName names a single entry after itself', () => {
  assertEqual(archiveDefaultName([FILE]), 'notes.md.zip', 'single file')
  assertEqual(archiveDefaultName([DIR]), 'docs.zip', 'single folder')
})

check('archiveDefaultName falls back to selection.zip for 0 or many entries', () => {
  assertEqual(archiveDefaultName([]), 'selection.zip', 'empty selection')
  assertEqual(archiveDefaultName([FILE, DIR]), 'selection.zip', 'multi-select')
})

console.log(`\n${passed} passed`)
