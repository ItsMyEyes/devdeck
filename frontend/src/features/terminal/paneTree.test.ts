/**
 * Plain assertion-based tests for paneTree.ts.
 *
 * No test runner (Vitest/Jest) is configured in this frontend project
 * (checked package.json + vite.config.ts — no test script, no vitest
 * dependency), so this is NOT wired into `npm run typecheck`/`npm test`
 * and won't be auto-discovered by any runner. It's a standalone script:
 * every `check()` call throws on failure, `main()` runs them all and
 * prints a pass count. Run manually with:
 *
 *   npx tsx src/features/terminal/paneTree.test.ts
 *
 * (or any other TS-capable runner — ts-node, `node --experimental-strip-types`
 * on Node 22.6+, etc.) If Vitest is added to this project later, these
 * `check()` bodies translate 1:1 into `it()` blocks.
 */

import {
  closeTab,
  createDefaultLayout,
  createFileContent,
  createGitContent,
  deserializeLayout,
  findPane,
  focusPane,
  moveTabInLayout,
  resizeSplitInLayout,
  serializeLayout,
  splitLeaf,
  type LeafPane,
  type SplitPane,
  type WorktreeLayout,
} from './paneTree'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

// ---------------------------------------------------------------------------

check('createDefaultLayout builds a single terminal leaf', () => {
  const layout = createDefaultLayout('w-1')
  assertEqual(layout.version, 1, 'version')
  assertEqual(layout.nextTerminalSeq, 1, 'nextTerminalSeq')
  assert(layout.root.type === 'leaf', 'root is a leaf')
  const root = layout.root as LeafPane
  assertEqual(root.tabs.length, 1, 'one tab')
  assertEqual(root.tabs[0].kind, 'terminal', 'terminal tab')
  assertEqual(root.tabs[0].id, 'w-1', 'primary terminal id === worktree id')
  assertEqual(root.activeTabId, 'w-1', 'active tab is the terminal')
  assertEqual(layout.focusedPaneId, root.id, 'focused pane is the root leaf')
})

check('split: splitLeaf turns a leaf into a 2-child row split', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const next = splitLeaf(layout, rootId, 'row', git)

  assert(next.root.type === 'split', 'root became a split')
  const split = next.root as SplitPane
  assertEqual(split.direction, 'row', 'split direction')
  assertEqual(split.children.length, 2, 'two children')
  assertEqual(split.sizes.length, 2, 'two sizes')
  assertEqual(split.sizes[0], 0.5, 'equal share 1')
  assertEqual(split.sizes[1], 0.5, 'equal share 2')

  const [first, second] = split.children
  assert(first.type === 'leaf' && first.id === rootId, 'original leaf kept its id, inserted first')
  assert(second.type === 'leaf', 'new leaf is a leaf')
  const secondLeaf = second as LeafPane
  assertEqual(secondLeaf.tabs.length, 1, 'new leaf has exactly the git tab')
  assertEqual(secondLeaf.tabs[0].id, git.id, 'new leaf holds the git content')
  assertEqual(secondLeaf.activeTabId, git.id, 'new leaf active tab is the git content')

  // original leaf's own tabs/content are untouched
  const firstLeaf = first as LeafPane
  assertEqual(firstLeaf.tabs.length, 1, 'original leaf still has just its terminal tab')
})

check('close-with-collapse: closing a split-created leaf collapses back to a single leaf', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const split = splitLeaf(layout, rootId, 'row', git)

  const splitRoot = split.root as SplitPane
  const newLeaf = splitRoot.children[1] as LeafPane

  const closed = closeTab(split, newLeaf.id, git.id)
  assert(closed.root.type === 'leaf', 'root collapsed back to a leaf, no residual split node')
  assertEqual(closed.root.id, rootId, 'the surviving leaf is the original root leaf')
  const survivor = closed.root as LeafPane
  assertEqual(survivor.tabs.length, 1, 'survivor only has its original tab')
  assertEqual(survivor.tabs[0].id, 'w-1', 'survivor tab is the primary terminal')
})

check('close-with-collapse: closing the last tab of the only leaf is a defensive no-op', () => {
  const layout = createDefaultLayout('w-1')
  const rootLeaf = layout.root as LeafPane
  const result = closeTab(layout, rootLeaf.id, 'w-1')
  assert(result === layout, 'unchanged layout returned, tree never goes fully empty')
})

check('close-with-collapse: closing a non-active tab reassigns activeTabId sanely', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const explorer = createFileContent('src/app.ts')
  let l = splitLeaf(layout, rootId, 'row', git)
  // merge a third tab onto the original leaf via center-zone move so one
  // leaf holds >1 tab to exercise activeTabId reassignment.
  const splitRoot = l.root as SplitPane
  const gitLeaf = splitRoot.children[1] as LeafPane
  l = splitLeaf(l, gitLeaf.id, 'row', explorer) // now 3 leaves in a row split, just to build up state

  const three = l.root as SplitPane
  assertEqual(three.children.length, 3, 'three leaves before pruning back down')
})

check('move-tab-creates-new-split: dragging a tab to an edge zone splits it out', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const file = createFileContent('src/main.ts')
  // column split: [terminal leaf, file leaf]
  const afterSplit = splitLeaf(layout, rootId, 'column', file)
  const columnSplit = afterSplit.root as SplitPane
  const terminalLeaf = columnSplit.children[0] as LeafPane
  const fileLeaf = columnSplit.children[1] as LeafPane
  assertEqual(columnSplit.direction, 'column', 'sanity: column split')

  // Drag the file tab from fileLeaf onto terminalLeaf's *right* edge — a
  // different direction (row) than the enclosing split (column), so this
  // wraps terminalLeaf in a new row-split. Removing the file tab empties
  // fileLeaf, which collapses the outer column split down to just the new
  // row-split.
  const moved = moveTabInLayout(afterSplit, fileLeaf.id, terminalLeaf.id, file.id, 'right')

  assert(moved.root.type === 'split', 'root is a split')
  const rowSplit = moved.root as SplitPane
  assertEqual(rowSplit.direction, 'row', 'outer column split collapsed away, leaving the new row split as root')
  assertEqual(rowSplit.children.length, 2, 'two children')
  const [left, right] = rowSplit.children
  assert(left.type === 'leaf' && left.id === terminalLeaf.id, 'terminal leaf stayed in place, on the left')
  assert(right.type === 'leaf', 'right side is a leaf')
  const rightLeaf = right as LeafPane
  assertEqual(rightLeaf.tabs.length, 1, 'new leaf holds only the dragged file tab')
  assertEqual(rightLeaf.tabs[0].id, file.id, 'dragged content landed on the right')

  // no leftover leaf with the old fileLeaf.id anywhere in the tree
  assert(findPane(moved.root, fileLeaf.id) === undefined, 'source leaf is gone, not a degenerate empty node')
})

check('move-tab-onto-center-merges-as-tab: dropping on center merges into the target leaf, source collapses', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const file = createFileContent('src/main.ts')
  const afterSplit = splitLeaf(layout, rootId, 'row', file)
  const rowSplit = afterSplit.root as SplitPane
  const terminalLeaf = rowSplit.children[0] as LeafPane
  const fileLeaf = rowSplit.children[1] as LeafPane

  const moved = moveTabInLayout(afterSplit, fileLeaf.id, terminalLeaf.id, file.id, 'center')

  assert(moved.root.type === 'leaf', 'split collapsed to a single leaf — no structural split remains')
  const merged = moved.root as LeafPane
  assertEqual(merged.id, terminalLeaf.id, 'surviving leaf is the merge target')
  assertEqual(merged.tabs.length, 2, 'target leaf now holds both tabs')
  assert(merged.tabs.some((t) => t.id === 'w-1'), 'still has the terminal tab')
  assert(merged.tabs.some((t) => t.id === file.id), 'now also has the file tab')
  assertEqual(merged.activeTabId, file.id, 'merged tab becomes active')
})

check('move-tab center zone onto the same single-tab pane is a no-op', () => {
  const layout = createDefaultLayout('w-1')
  const rootLeaf = layout.root as LeafPane
  const moved = moveTabInLayout(layout, rootLeaf.id, rootLeaf.id, 'w-1', 'center')
  assert(moved === layout, 'unchanged layout returned')
})

check('resize: resizeSplitInLayout normalizes sizes to sum to 1', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const split = splitLeaf(layout, rootId, 'row', git)
  const splitId = split.root.id

  const resized = resizeSplitInLayout(split, splitId, [0.2, 0.4]) // sums to 0.6
  const sizes = (resized.root as SplitPane).sizes
  const sum = sizes[0] + sizes[1]
  assert(Math.abs(sum - 1) < 1e-9, `sizes normalized to sum 1, got ${sum}`)
  assert(Math.abs(sizes[0] / sizes[1] - 0.5) < 1e-9, 'relative proportions preserved (0.2:0.4 == 1:2)')
})

check('resize: mismatched sizes length is a no-op', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const split = splitLeaf(layout, rootId, 'row', git)
  const resized = resizeSplitInLayout(split, split.root.id, [1])
  assert(resized === split, 'unchanged layout returned for a bad sizes array')
})

check('find/focus: focusPane updates focusedPaneId only for panes that exist', () => {
  const layout = createDefaultLayout('w-1')
  const rootId = layout.root.id
  const git = createGitContent()
  const split = splitLeaf(layout, rootId, 'row', git)
  const gitLeaf = (split.root as SplitPane).children[1] as LeafPane

  const focused = focusPane(split, gitLeaf.id)
  assertEqual(focused.focusedPaneId, gitLeaf.id, 'focus moved to the git leaf')

  const unchanged = focusPane(focused, 'does-not-exist')
  assert(unchanged === focused, 'focusing an unknown pane id is a no-op')
})

check('serialize/deserialize round-trips a valid layout and rejects garbage', () => {
  const layout = createDefaultLayout('w-1')
  const git = createGitContent()
  const split = splitLeaf(layout, layout.root.id, 'row', git)

  const wire = serializeLayout(split)
  assert(wire !== split, 'serialize returns a distinct deep clone')
  assert(JSON.stringify(wire) === JSON.stringify(split), 'clone is structurally identical')

  const restored = deserializeLayout(wire)
  assert(restored !== null, 'valid layout deserializes')
  assert(JSON.stringify(restored) === JSON.stringify(split), 'restored layout matches original')

  assertEqual(deserializeLayout(null), null, 'null rejected')
  assertEqual(deserializeLayout(undefined), null, 'undefined rejected')
  assertEqual(deserializeLayout('not an object'), null, 'non-object rejected')
  assertEqual(deserializeLayout({ version: 2, root: {} }), null, 'wrong version rejected')
  assertEqual(deserializeLayout({ version: 1 }), null, 'missing root rejected')
  assertEqual(
    deserializeLayout({ version: 1, root: {}, focusedPaneId: 'x' }),
    null,
    'missing nextTerminalSeq rejected',
  )
})

function main() {
  console.log(`\n${passed} passed`)
}

main()

// Type-only sanity check that WorktreeLayout is exported and usable by
// consumers without re-deriving the shape by hand.
const _typeCheck: WorktreeLayout = createDefaultLayout('w-typecheck')
void _typeCheck
