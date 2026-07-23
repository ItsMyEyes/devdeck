/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's and
 * paneTree.test.ts's convention (no Vitest/Jest configured in this project).
 * Run manually with:
 *
 *   npx tsx src/features/database/dbTabs.test.ts
 */

import { closeTab, emptyDBTabState, openTab, reorderTab, setActiveTab, tabId } from './dbTabs'

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

const OBJ = { database: 'd', schema: 's', name: 't', kind: 'table' as const }

check('opening a table adds one tab and activates it', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  assertEqual(s.tabs.length, 1, 'one tab')
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'activated')
})

check('opening the same table twice focuses the existing tab, not a duplicate', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: OBJ })
  assertEqual(s.tabs.length, 1, 'still one tab')
})

check('table and ddl tabs for the same object are distinct', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'ddl', object: OBJ })
  assertEqual(s.tabs.length, 2, 'two distinct tabs')
})

check('closing the active tab activates its neighbor, not null, when one exists', () => {
  const objB = { ...OBJ, name: 'u' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = closeTab(s, tabId({ kind: 'table', object: objB }))
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'falls back to the remaining tab')
})

check('closing the last tab leaves activeTabId null', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = closeTab(s, tabId({ kind: 'table', object: OBJ }))
  assertEqual(s.tabs.length, 0, 'no tabs left')
  assertEqual(s.activeTabId, null, 'no active tab')
})

check('closing a non-active tab leaves the active tab untouched', () => {
  const objB = { ...OBJ, name: 'u' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = setActiveTab(s, tabId({ kind: 'table', object: OBJ }))
  s = closeTab(s, tabId({ kind: 'table', object: objB }))
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'unchanged')
})

check('designer tabs for "new table" and an existing table are distinct, and dedupe within themselves', () => {
  let s = openTab(emptyDBTabState(), { kind: 'designer', object: null })
  s = openTab(s, { kind: 'designer', object: null })
  assertEqual(s.tabs.length, 1, 'opening "new table" designer twice still yields one tab')
  s = openTab(s, { kind: 'designer', object: OBJ })
  assertEqual(s.tabs.length, 2, 'a designer tab for an existing table is distinct from "new table"')
  assertEqual(tabId({ kind: 'designer', object: null }), 'designer:new', 'stable id for the create-new case')
})

check('setActiveTab is a no-op for an id that is not open', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const s2 = setActiveTab(s, 'not-a-real-id')
  assertEqual(s2, s, 'state unchanged')
})

check('reorderTab moves a tab before another', () => {
  const objB = { ...OBJ, name: 'u' }
  const objC = { ...OBJ, name: 'v' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = openTab(s, { kind: 'table', object: objC })
  const idA = tabId({ kind: 'table', object: OBJ })
  const idB = tabId({ kind: 'table', object: objB })
  const idC = tabId({ kind: 'table', object: objC })
  s = reorderTab(s, idC, idA)
  assertEqual(s.tabs.map((t) => t.id), [idC, idA, idB], 'C moved before A')
})

check('reorderTab moves to the end when the target id is not found', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const objB = { ...OBJ, name: 'u' }
  s = openTab(s, { kind: 'table', object: objB })
  const idA = tabId({ kind: 'table', object: OBJ })
  s = reorderTab(s, idA, 'not-a-real-id')
  assertEqual(s.tabs.map((t) => t.id), [tabId({ kind: 'table', object: objB }), idA], 'A moved to end')
})

check('reorderTab is a no-op when fromId equals toId', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const idA = tabId({ kind: 'table', object: OBJ })
  const s2 = reorderTab(s, idA, idA)
  assertEqual(s2, s, 'state unchanged')
})

console.log(`\n${passed} tests passed`)
