/**
 * Pure data model + tree-manipulation logic for the desktop workspace-level
 * tab tiling ("split a tab to show two worktrees at once"). Deliberately
 * isolated from `../terminal/paneTree.ts` (the per-worktree pane engine) —
 * see docs/superpowers/specs/2026-07-13-workspace-tile-splitting-design.md
 * ("Why a separate engine, not a generalized one") for why this is a
 * separate, closely-modeled copy rather than a shared/generic engine.
 *
 * Every mutation function is pure: it takes a tree (or a
 * `WorkspaceTileLayout`) and returns a new one, structurally sharing
 * untouched subtrees.
 */

export type TileTab =
  | { kind: 'agents'; id: 'agents' }
  | { kind: 'worktree'; id: string; projectId: string; wtId: string }
  | { kind: 'browser'; id: string }
  | { kind: 'ssh-shell'; id: string; connectionId: string }

export interface TileLeaf {
  type: 'leaf'
  id: string
  /** length >= 1 always; 0 tabs => leaf is removed (see removeTabFromNode). */
  tabs: TileTab[]
  /** === one tabs[].id */
  activeTabId: string
}

/** row = side-by-side, column = stacked. */
export type TileSplitDirection = 'row' | 'column'

export interface TileSplit {
  type: 'split'
  id: string
  direction: TileSplitDirection
  /** length >= 2 always — see collapse invariant in removeTabFromNode. */
  children: TileNode[]
  /** same length as children, fractions summing to 1. */
  sizes: number[]
}

export type TileNode = TileLeaf | TileSplit

export interface WorkspaceTileLayout {
  version: 1
  root: TileNode
  /** Which leaf a newly-opened tab lands in, and which leaf's strip
   *  keyboard shortcuts (Cmd+W, Cmd+Shift+[/]) operate on. */
  focusedLeafId: string
}

/** The 5 drag-and-drop zones a dropped tab can land in relative to the
 *  target leaf's content body. */
export type TileDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

function generateTileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// Tab factories
// ---------------------------------------------------------------------------

export const AGENTS_TAB: TileTab = { kind: 'agents', id: 'agents' }

export function createWorktreeTab(projectId: string, wtId: string): TileTab {
  return { kind: 'worktree', id: wtId, projectId, wtId }
}

/** A Browser tile carries no routing data of its own — unlike a worktree
 *  tab (which points at a backend-owned worktree by id), a browser tab's
 *  live state (url, history, machine/proxy) lives entirely in the store's
 *  `browserTiles` slice, keyed by this same generated id. */
export function createBrowserTab(): TileTab {
  return { kind: 'browser', id: generateTileId() }
}

/** An ssh-shell tile's id is derived from its connection id, so opening the
 *  same saved connection twice focuses the existing shell instead of
 *  spawning a second one (same dedupe contract as worktree tabs). */
export function createSSHShellTab(connectionId: string): TileTab {
  return { kind: 'ssh-shell', id: `ssh-${connectionId}`, connectionId }
}

/** The default layout for a workspace with no persisted entry yet: a
 *  single leaf holding just the pinned Agents tab, active. */
export function createDefaultTileLayout(): WorkspaceTileLayout {
  const rootId = generateTileId()
  return {
    version: 1,
    focusedLeafId: rootId,
    root: { type: 'leaf', id: rootId, tabs: [AGENTS_TAB], activeTabId: AGENTS_TAB.id },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

function renormalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, s) => sum + s, 0)
  if (!(total > 0)) return equalSizes(sizes.length)
  return sizes.map((s) => s / total)
}

/** Always-first-child walk — also used to find the leaf that renders in
 *  the tiling grid's actual top-left corner (row splits' first child is
 *  visually left, column splits' first child is visually top, so this
 *  walk lands on the true top-left leaf regardless of nesting). */
export function firstLeafId(node: TileNode): string | undefined {
  if (node.type === 'leaf') return node.id
  for (const child of node.children) {
    const found = firstLeafId(child)
    if (found) return found
  }
  return undefined
}

function mapTree(node: TileNode, predicate: (n: TileNode) => boolean, update: (n: TileNode) => TileNode): TileNode {
  if (predicate(node)) return update(node)
  if (node.type === 'split') {
    let changed = false
    const children = node.children.map((child) => {
      const next = mapTree(child, predicate, update)
      if (next !== child) changed = true
      return next
    })
    return changed ? { ...node, children } : node
  }
  return node
}

/** Inserts `newLeaf` adjacent to `targetLeafId`: if the target's parent
 *  split already has `direction`, insert as a same-direction sibling;
 *  otherwise wrap the target in a brand-new 2-child split of `direction`.
 *  Either way the affected split's sizes reset to equal shares. If
 *  `targetLeafId` is the tree root (no parent), the whole tree is wrapped
 *  instead. */
function insertLeafAdjacent(
  root: TileNode,
  targetLeafId: string,
  direction: TileSplitDirection,
  newLeaf: TileLeaf,
  position: 'before' | 'after',
): TileNode {
  if (root.id === targetLeafId) {
    const children = position === 'before' ? [newLeaf, root] : [root, newLeaf]
    return { type: 'split', id: generateTileId(), direction, children, sizes: equalSizes(2) }
  }
  return insertIntoParent(root, targetLeafId, direction, newLeaf, position) ?? root
}

function insertIntoParent(
  node: TileNode,
  targetLeafId: string,
  direction: TileSplitDirection,
  newLeaf: TileLeaf,
  position: 'before' | 'after',
): TileNode | null {
  if (node.type === 'leaf') return null

  const idx = node.children.findIndex((c) => c.id === targetLeafId)
  if (idx !== -1) {
    if (node.direction === direction) {
      const children = [...node.children]
      children.splice(position === 'before' ? idx : idx + 1, 0, newLeaf)
      return { ...node, children, sizes: equalSizes(children.length) }
    }
    const target = node.children[idx]
    const wrapped: TileSplit = {
      type: 'split',
      id: generateTileId(),
      direction,
      children: position === 'before' ? [newLeaf, target] : [target, newLeaf],
      sizes: equalSizes(2),
    }
    const children = [...node.children]
    children[idx] = wrapped
    return { ...node, children }
  }

  for (let i = 0; i < node.children.length; i++) {
    const result = insertIntoParent(node.children[i], targetLeafId, direction, newLeaf, position)
    if (result) {
      const children = [...node.children]
      children[i] = result
      return { ...node, children }
    }
  }
  return null
}

/** Removes `tabId` from the leaf `leafId`. Empties that leaf => the leaf
 *  itself is dropped from its parent's children; dropping a parent to
 *  exactly 1 remaining child collapses the parent into that child,
 *  recursively up the tree. Returns `null` if the whole tree became empty
 *  — in practice this never happens, since the pinned Agents tab is never
 *  removable, so at least one leaf (the one holding it) always survives. */
function removeTabFromNode(node: TileNode, leafId: string, tabId: string): TileNode | null {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node
    if (!node.tabs.some((t) => t.id === tabId)) return node
    const tabs = node.tabs.filter((t) => t.id !== tabId)
    if (tabs.length === 0) return null
    let activeTabId = node.activeTabId
    if (activeTabId === tabId) {
      const oldIndex = node.tabs.findIndex((t) => t.id === tabId)
      activeTabId = (tabs[oldIndex] ?? tabs[oldIndex - 1] ?? tabs[tabs.length - 1]).id
    }
    return { ...node, tabs, activeTabId }
  }

  let changed = false
  const nextChildren: TileNode[] = []
  const nextSizes: number[] = []
  node.children.forEach((child, i) => {
    const result = removeTabFromNode(child, leafId, tabId)
    if (result === null) {
      changed = true
      return
    }
    if (result !== child) changed = true
    nextChildren.push(result)
    nextSizes.push(node.sizes[i])
  })
  if (!changed) return node
  if (nextChildren.length === 0) return null
  if (nextChildren.length === 1) return nextChildren[0]
  return { ...node, children: nextChildren, sizes: renormalizeSizes(nextSizes) }
}

function mergeTabIntoLeaf(root: TileNode, targetLeafId: string, tab: TileTab): TileNode {
  return mapTree(
    root,
    (n) => n.type === 'leaf' && n.id === targetLeafId,
    (n) => {
      const leaf = n as TileLeaf
      if (leaf.tabs.some((t) => t.id === tab.id)) return leaf
      return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tab.id }
    },
  )
}

// ---------------------------------------------------------------------------
// find / focus / select
// ---------------------------------------------------------------------------

export function findTileLeaf(root: TileNode, leafId: string): TileNode | undefined {
  if (root.id === leafId) return root
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findTileLeaf(child, leafId)
      if (found) return found
    }
  }
  return undefined
}

export function findTileTab(root: TileNode, tabId: string): TileTab | undefined {
  if (root.type === 'leaf') return root.tabs.find((t) => t.id === tabId)
  for (const child of root.children) {
    const found = findTileTab(child, tabId)
    if (found) return found
  }
  return undefined
}

export function findLeafForTab(root: TileNode, tabId: string): TileLeaf | undefined {
  if (root.type === 'leaf') return root.tabs.some((t) => t.id === tabId) ? root : undefined
  for (const child of root.children) {
    const found = findLeafForTab(child, tabId)
    if (found) return found
  }
  return undefined
}

/** Sets `focusedLeafId`, a no-op if `leafId` doesn't exist in the tree or
 *  is already focused. */
export function focusTileLeaf(layout: WorkspaceTileLayout, leafId: string): WorkspaceTileLayout {
  if (layout.focusedLeafId === leafId) return layout
  if (!findTileLeaf(layout.root, leafId)) return layout
  return { ...layout, focusedLeafId: leafId }
}

/** Switches which tab is active within one leaf — no structural change. */
export function selectTileTab(layout: WorkspaceTileLayout, leafId: string, tabId: string): WorkspaceTileLayout {
  const root = mapTree(
    layout.root,
    (n) => n.type === 'leaf' && n.id === leafId,
    (n) => {
      const leaf = n as TileLeaf
      if (!leaf.tabs.some((t) => t.id === tabId) || leaf.activeTabId === tabId) return leaf
      return { ...leaf, activeTabId: tabId }
    },
  )
  return root === layout.root ? layout : { ...layout, root }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/** Opens `tab` in the layout: if it already exists anywhere in the tree,
 *  focuses its leaf and makes it active there (never duplicates);
 *  otherwise adds it as a new tab in the currently focused leaf and makes
 *  it active there. */
export function openTileTab(layout: WorkspaceTileLayout, tab: TileTab): WorkspaceTileLayout {
  const existingLeaf = findLeafForTab(layout.root, tab.id)
  if (existingLeaf) {
    return focusTileLeaf(selectTileTab(layout, existingLeaf.id, tab.id), existingLeaf.id)
  }
  const root = mergeTabIntoLeaf(layout.root, layout.focusedLeafId, tab)
  return { ...layout, root }
}

// ---------------------------------------------------------------------------
// close (with single-child collapse)
// ---------------------------------------------------------------------------

/** Closes one tab from a leaf, applying the collapse invariant. The pinned
 *  Agents tab is never closable — a no-op if `tabId === 'agents'`. If the
 *  closed tab's leaf was focused and got collapsed away, focus falls back
 *  to the tree's first leaf. */
export function closeTileTab(layout: WorkspaceTileLayout, leafId: string, tabId: string): WorkspaceTileLayout {
  if (tabId === 'agents') return layout
  const nextRoot = removeTabFromNode(layout.root, leafId, tabId)
  if (nextRoot === null || nextRoot === layout.root) return layout
  const focusedLeafId = findTileLeaf(nextRoot, layout.focusedLeafId)
    ? layout.focusedLeafId
    : (firstLeafId(nextRoot) ?? layout.focusedLeafId)
  return { ...layout, root: nextRoot, focusedLeafId }
}

// ---------------------------------------------------------------------------
// move a tab between leaves (drag-and-drop commit)
// ---------------------------------------------------------------------------

/** Commits a drag-and-drop drop: moves `tabId` out of `sourceLeafId` and
 *  into `targetLeafId` per the 5-zone rule. `center` merges as a new tab
 *  into the target leaf (no structural change); `left`/`right`/`top`/
 *  `bottom` remove the tab from its source and insert it as a new sibling
 *  leaf, splitting the target's parent (or wrapping the target) in the
 *  implied direction. A no-op if the tab can't be found, or if source and
 *  target are the same leaf and the drop wouldn't change anything (only
 *  tab in that leaf, dropped back on itself). */
export function moveTileTab(
  root: TileNode,
  sourceLeafId: string,
  targetLeafId: string,
  tabId: string,
  zone: TileDropZone,
): TileNode {
  const sourceLeaf = findTileLeaf(root, sourceLeafId)
  if (!sourceLeaf || sourceLeaf.type !== 'leaf') return root
  const tab = sourceLeaf.tabs.find((t) => t.id === tabId)
  if (!tab) return root

  if (zone === 'center') {
    if (sourceLeafId === targetLeafId) return root
    const targetLeaf = findTileLeaf(root, targetLeafId)
    if (!targetLeaf || targetLeaf.type !== 'leaf') return root
    const afterRemoval = removeTabFromNode(root, sourceLeafId, tabId)
    if (afterRemoval === null) return root
    return mergeTabIntoLeaf(afterRemoval, targetLeafId, tab)
  }

  if (sourceLeafId === targetLeafId && sourceLeaf.tabs.length === 1) return root

  const direction: TileSplitDirection = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const position: 'before' | 'after' = zone === 'left' || zone === 'top' ? 'before' : 'after'
  const afterRemoval = removeTabFromNode(root, sourceLeafId, tabId)
  if (afterRemoval === null) return root
  const newLeaf: TileLeaf = { type: 'leaf', id: generateTileId(), tabs: [tab], activeTabId: tab.id }
  return insertLeafAdjacent(afterRemoval, targetLeafId, direction, newLeaf, position)
}

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

export function resizeTileSplit(root: TileNode, splitId: string, sizes: number[]): TileNode {
  return mapTree(
    root,
    (n) => n.type === 'split' && n.id === splitId,
    (n) => {
      const split = n as TileSplit
      if (sizes.length !== split.children.length) return split
      if (sizes.some((s) => !(s > 0))) return split
      return { ...split, sizes: renormalizeSizes(sizes) }
    },
  )
}

// ---------------------------------------------------------------------------
// prune (drop tabs for worktrees that no longer exist)
// ---------------------------------------------------------------------------

/** Removes every `worktree` tab whose `wtId` isn't in `liveWtIds`, applying
 *  the same leaf/split collapse rule as `closeTileTab`. The pinned Agents
 *  tab is never pruned (it isn't a `worktree`-kind tab). */
export function pruneTileTabs(layout: WorkspaceTileLayout, liveWtIds: Set<string>): WorkspaceTileLayout {
  const staleIds: string[] = []
  function collectStale(node: TileNode) {
    if (node.type === 'leaf') {
      for (const tab of node.tabs) {
        if (tab.kind === 'worktree' && !liveWtIds.has(tab.wtId)) staleIds.push(tab.id)
      }
      return
    }
    node.children.forEach(collectStale)
  }
  collectStale(layout.root)

  let current = layout
  for (const tabId of staleIds) {
    const leaf = findLeafForTab(current.root, tabId)
    if (leaf) current = closeTileTab(current, leaf.id, tabId)
  }
  return current
}

// ---------------------------------------------------------------------------
// deserialize (persistence)
// ---------------------------------------------------------------------------

/** Light shape check for a value read back from persisted storage. Callers
 *  should fall back to `createDefaultTileLayout()` on `null`. */
export function deserializeTileLayout(value: unknown): WorkspaceTileLayout | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WorkspaceTileLayout>
  if (candidate.version !== 1 || !candidate.root) return null
  if (typeof candidate.focusedLeafId !== 'string') return null
  return candidate as WorkspaceTileLayout
}
