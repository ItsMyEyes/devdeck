/**
 * Plain assertion-based tests for the ssh-shell tile kind in tileTree.ts.
 * Same standalone-harness convention as ../terminal/paneTree.test.ts (no
 * Vitest/Jest is configured in this project). Run manually with:
 *
 *   npx tsx src/features/tabs/tileTree.ssh.test.ts
 */

import { closeTileTab, createDefaultTileLayout, createSSHShellTab, findTileLeaf, openTileTab } from './tileTree'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

check('createSSHShellTab derives a stable id from the connection id', () => {
  const tab = createSSHShellTab('sc-1a2b3c4d')
  assert(tab.kind === 'ssh-shell', 'kind is ssh-shell')
  assert(tab.id === 'ssh-sc-1a2b3c4d', `id is derived (got ${tab.id})`)
  assert(tab.connectionId === 'sc-1a2b3c4d', 'connectionId is kept')
})

check('openTileTab adds an ssh-shell tab and makes it active', () => {
  const layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  assert(leaf.tabs.some((t) => t.id === 'ssh-sc-1'), 'ssh tab is in the leaf')
  assert(leaf.activeTabId === 'ssh-sc-1', 'ssh tab is active')
})

check('re-opening the same connection focuses the existing tab instead of duplicating', () => {
  let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  layout = openTileTab(layout, createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  const sshTabs = leaf.tabs.filter((t) => t.kind === 'ssh-shell')
  assert(sshTabs.length === 1, `exactly one ssh tab (got ${sshTabs.length})`)
})

check('closeTileTab removes an ssh-shell tab', () => {
  let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  layout = closeTileTab(layout, leaf.id, 'ssh-sc-1')
  const after = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(after?.type === 'leaf' && !after.tabs.some((t) => t.id === 'ssh-sc-1'), 'ssh tab removed')
})

console.log(`\n${passed} checks passed`)
