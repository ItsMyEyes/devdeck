/**
 * Plain assertion-based tests, matching paneTree.test.ts's convention (no
 * Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/features/terminal/fileTreeSelection.test.ts
 */

import { applySelectionClick, emptySelection, modifierFromEvent, type SelectedEntry } from './fileTreeSelection'

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

const A: SelectedEntry = { name: 'a.ts', path: 'a.ts', isDir: false }
const B: SelectedEntry = { name: 'b.ts', path: 'b.ts', isDir: false }
const C: SelectedEntry = { name: 'c.ts', path: 'c.ts', isDir: false }
const D: SelectedEntry = { name: 'd.ts', path: 'd.ts', isDir: false }
const ORDER = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
const ENTRIES: Record<string, SelectedEntry> = { 'a.ts': A, 'b.ts': B, 'c.ts': C, 'd.ts': D }
const entryOf = (path: string) => ENTRIES[path]

check('modifierFromEvent: shift wins over ctrl/cmd', () => {
  assertEqual(modifierFromEvent({ metaKey: true, ctrlKey: false, shiftKey: true }), 'range', 'shift+meta')
  assertEqual(modifierFromEvent({ metaKey: true, ctrlKey: false, shiftKey: false }), 'toggle', 'meta only')
  assertEqual(modifierFromEvent({ metaKey: false, ctrlKey: true, shiftKey: false }), 'toggle', 'ctrl only')
  assertEqual(modifierFromEvent({ metaKey: false, ctrlKey: false, shiftKey: false }), 'none', 'no modifier')
})

check('plain click replaces the selection with just the clicked row', () => {
  const state = applySelectionClick({ selected: { 'x.ts': A }, anchor: 'x.ts' }, B, 'none', ORDER, entryOf)
  assertEqual(state.selected, { 'b.ts': B }, 'selected')
  assertEqual(state.anchor, 'b.ts', 'anchor')
})

check('ctrl/cmd click toggles a row into the selection', () => {
  const state = applySelectionClick(emptySelection(), A, 'toggle', ORDER, entryOf)
  assertEqual(state.selected, { 'a.ts': A }, 'added')
  const state2 = applySelectionClick(state, B, 'toggle', ORDER, entryOf)
  assertEqual(state2.selected, { 'a.ts': A, 'b.ts': B }, 'both present')
})

check('ctrl/cmd click toggles a row out of the selection', () => {
  const state = applySelectionClick({ selected: { 'a.ts': A, 'b.ts': B }, anchor: 'a.ts' }, A, 'toggle', ORDER, entryOf)
  assertEqual(state.selected, { 'b.ts': B }, 'a removed, b remains')
})

check('shift click selects the range between anchor and target (forward)', () => {
  const afterA = applySelectionClick(emptySelection(), A, 'none', ORDER, entryOf)
  const ranged = applySelectionClick(afterA, C, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'a.ts': A, 'b.ts': B, 'c.ts': C }, 'a through c')
  assertEqual(ranged.anchor, 'a.ts', 'anchor unchanged by range click')
})

check('shift click selects the range between anchor and target (backward)', () => {
  const afterC = applySelectionClick(emptySelection(), C, 'none', ORDER, entryOf)
  const ranged = applySelectionClick(afterC, A, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'a.ts': A, 'b.ts': B, 'c.ts': C }, 'a through c regardless of direction')
})

check('shift click with no prior anchor falls back to selecting just the clicked row', () => {
  const ranged = applySelectionClick(emptySelection(), D, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'd.ts': D }, 'single row')
  assertEqual(ranged.anchor, 'd.ts', 'anchor set')
})

console.log(`\n${passed} passed`)
