/**
 * Pure data model + tree-manipulation logic for the terminal workspace
 * tiling redesign. No React, no UI — see
 * docs/superpowers/specs/2026-07-09-terminal-workspace-tiling-design.md
 * ("PaneNode / PaneContent data model" section) for the design this
 * implements verbatim.
 *
 * Every mutation function is pure: it takes a tree (or a `WorktreeLayout`)
 * and returns a new one, structurally sharing untouched subtrees. Nothing
 * here touches `useLoomStore` — the store slice that persists
 * `WorktreeLayout` per worktree is a separate, later integration step.
 */

export type PaneContentKind = 'terminal' | 'git' | 'file' | 'explorer'

interface BasePaneContent {
  /** Globally unique within one worktree's tree — see id rules below. */
  id: string
  kind: PaneContentKind
  label: string
}

export interface TerminalContent extends BasePaneContent {
  kind: 'terminal'
  /** Also this content's `id`. Primary pane uses the bare worktree id;
   *  every other Terminal content uses `${worktreeId}::term-${n}`. */
  sessionKey: string
}

export interface GitContent extends BasePaneContent {
  kind: 'git'
}

export interface FileContent extends BasePaneContent {
  kind: 'file'
  /** Also this content's `id` — enforces "one instance per open path"
   *  across the whole tree. */
  path: string
}

export interface ExplorerContent extends BasePaneContent {
  kind: 'explorer'
}

export type PaneContent = TerminalContent | GitContent | FileContent | ExplorerContent

export interface LeafPane {
  type: 'leaf'
  id: string
  /** length >= 1 always; 0 tabs => leaf is removed (see removeContent). */
  tabs: PaneContent[]
  /** === one tabs[].id */
  activeTabId: string
}

/** row = side-by-side ("split right"), column = stacked ("split down"). */
export type SplitDirection = 'row' | 'column'

export interface SplitPane {
  type: 'split'
  id: string
  direction: SplitDirection
  /** length >= 2 always — see collapse invariant in removeContent. */
  children: PaneNode[]
  /** same length as children, fractions summing to 1. */
  sizes: number[]
}

export type PaneNode = LeafPane | SplitPane

export interface WorktreeLayout {
  version: 1
  root: PaneNode
  /** Drives which pane's header shows the "..." menu and which Terminal
   *  pane MobileKeyToolbar/ctrlArmed targets. */
  focusedPaneId: string
  /** Monotonic, never reused even after a Terminal pane closes, so
   *  sessionKeys stay collision-free for the life of the layout. Starts
   *  at 1; the primary pane (bare worktree id) doesn't consume a slot. */
  nextTerminalSeq: number
}

/** The 5 drag-and-drop zones a dropped tab can land in relative to the
 *  target pane's content body (see spec's "Drag-and-drop interaction
 *  model" section). */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

/** Matches the existing fallback-safe pattern in
 *  `frontend/src/features/modules/BrowserModule.tsx`. */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// Content factories (enforce the id rules from the spec)
// ---------------------------------------------------------------------------

export function createPrimaryTerminalContent(worktreeId: string): TerminalContent {
  return { kind: 'terminal', id: worktreeId, sessionKey: worktreeId, label: 'Terminal' }
}

export function createTerminalContent(worktreeId: string, seq: number): TerminalContent {
  const sessionKey = `${worktreeId}::term-${seq}`
  return { kind: 'terminal', id: sessionKey, sessionKey, label: 'Terminal' }
}

/** Allocates a new non-primary Terminal content item and bumps
 *  `nextTerminalSeq` on the returned layout. Pure — does not mutate
 *  `layout`. */
export function allocateTerminalContent(
  layout: WorktreeLayout,
  worktreeId: string,
): { content: TerminalContent; layout: WorktreeLayout } {
  const content = createTerminalContent(worktreeId, layout.nextTerminalSeq)
  return { content, layout: { ...layout, nextTerminalSeq: layout.nextTerminalSeq + 1 } }
}

export function createGitContent(): GitContent {
  return { kind: 'git', id: generateId(), label: 'Git' }
}

export function createExplorerContent(): ExplorerContent {
  return { kind: 'explorer', id: generateId(), label: 'Explorer' }
}

export function createFileContent(path: string, label?: string): FileContent {
  return { kind: 'file', id: path, path, label: label ?? path.split('/').pop() ?? path }
}

/** The default layout for a worktree with no persisted entry yet —
 *  mirrors today's single-terminal view exactly. */
export function createDefaultLayout(worktreeId: string): WorktreeLayout {
  const rootId = generateId()
  const terminal = createPrimaryTerminalContent(worktreeId)
  return {
    version: 1,
    nextTerminalSeq: 1,
    focusedPaneId: rootId,
    root: {
      type: 'leaf',
      id: rootId,
      tabs: [terminal],
      activeTabId: terminal.id,
    },
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

function firstLeafId(node: PaneNode): string | undefined {
  if (node.type === 'leaf') return node.id
  for (const child of node.children) {
    const found = firstLeafId(child)
    if (found) return found
  }
  return undefined
}

/** Finds the node matching `predicate` anywhere in the tree and replaces it
 *  via `update`, structurally sharing every untouched subtree. Used for
 *  in-place field updates (resize, merge-as-tab) that don't change tree
 *  shape at the parent level. */
function mapTree(
  node: PaneNode,
  predicate: (n: PaneNode) => boolean,
  update: (n: PaneNode) => PaneNode,
): PaneNode {
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

/** Inserts `newLeaf` adjacent to `targetPaneId`, following the spec's
 *  "commit on drop" structural rule: if the target's parent split already
 *  has `direction`, insert as a same-direction sibling; otherwise wrap the
 *  target in a brand-new 2-child split of `direction`. Either way the
 *  affected split's sizes reset to equal shares. If `targetPaneId` is the
 *  tree root (no parent), the whole tree is wrapped instead. */
function insertLeafAdjacent(
  root: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: LeafPane,
  position: 'before' | 'after',
): PaneNode {
  if (root.id === targetPaneId) {
    const children = position === 'before' ? [newLeaf, root] : [root, newLeaf]
    return { type: 'split', id: generateId(), direction, children, sizes: equalSizes(2) }
  }
  return insertIntoParent(root, targetPaneId, direction, newLeaf, position) ?? root
}

function insertIntoParent(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: LeafPane,
  position: 'before' | 'after',
): PaneNode | null {
  if (node.type === 'leaf') return null

  const idx = node.children.findIndex((c) => c.id === targetPaneId)
  if (idx !== -1) {
    if (node.direction === direction) {
      const children = [...node.children]
      children.splice(position === 'before' ? idx : idx + 1, 0, newLeaf)
      return { ...node, children, sizes: equalSizes(children.length) }
    }
    const target = node.children[idx]
    const wrapped: SplitPane = {
      type: 'split',
      id: generateId(),
      direction,
      children: position === 'before' ? [newLeaf, target] : [target, newLeaf],
      sizes: equalSizes(2),
    }
    const children = [...node.children]
    children[idx] = wrapped
    return { ...node, children }
  }

  for (let i = 0; i < node.children.length; i++) {
    const result = insertIntoParent(node.children[i], targetPaneId, direction, newLeaf, position)
    if (result) {
      const children = [...node.children]
      children[i] = result
      return { ...node, children }
    }
  }
  return null
}

/** Removes `contentId` from the leaf `paneId`. Empties that leaf => the
 *  leaf itself is dropped from its parent's children; dropping a parent to
 *  exactly 1 remaining child collapses the parent into that child,
 *  recursively up the tree (the collapse invariant). Returns `null` if the
 *  whole tree became empty (removing the only tab of the only leaf). */
function removeContentFromNode(node: PaneNode, paneId: string, contentId: string): PaneNode | null {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node
    if (!node.tabs.some((t) => t.id === contentId)) return node
    const tabs = node.tabs.filter((t) => t.id !== contentId)
    if (tabs.length === 0) return null
    let activeTabId = node.activeTabId
    if (activeTabId === contentId) {
      const oldIndex = node.tabs.findIndex((t) => t.id === contentId)
      activeTabId = (tabs[oldIndex] ?? tabs[oldIndex - 1] ?? tabs[tabs.length - 1]).id
    }
    return { ...node, tabs, activeTabId }
  }

  let changed = false
  const nextChildren: PaneNode[] = []
  const nextSizes: number[] = []
  node.children.forEach((child, i) => {
    const result = removeContentFromNode(child, paneId, contentId)
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

function mergeContentIntoLeaf(root: PaneNode, targetPaneId: string, content: PaneContent): PaneNode {
  return mapTree(
    root,
    (n) => n.type === 'leaf' && n.id === targetPaneId,
    (n) => {
      const leaf = n as LeafPane
      if (leaf.tabs.some((t) => t.id === content.id)) return leaf
      return { ...leaf, tabs: [...leaf.tabs, content], activeTabId: content.id }
    },
  )
}

// ---------------------------------------------------------------------------
// find / focus
// ---------------------------------------------------------------------------

export function findPane(root: PaneNode, paneId: string): PaneNode | undefined {
  if (root.id === paneId) return root
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findPane(child, paneId)
      if (found) return found
    }
  }
  return undefined
}

export function findContent(root: PaneNode, contentId: string): PaneContent | undefined {
  if (root.type === 'leaf') return root.tabs.find((t) => t.id === contentId)
  for (const child of root.children) {
    const found = findContent(child, contentId)
    if (found) return found
  }
  return undefined
}

export function findLeafForContent(root: PaneNode, contentId: string): LeafPane | undefined {
  if (root.type === 'leaf') return root.tabs.some((t) => t.id === contentId) ? root : undefined
  for (const child of root.children) {
    const found = findLeafForContent(child, contentId)
    if (found) return found
  }
  return undefined
}

/** Sets `focusedPaneId`, a no-op if `paneId` doesn't exist in the tree or
 *  is already focused. */
export function focusPane(layout: WorktreeLayout, paneId: string): WorktreeLayout {
  if (layout.focusedPaneId === paneId) return layout
  if (!findPane(layout.root, paneId)) return layout
  return { ...layout, focusedPaneId: paneId }
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

/** Splits the leaf `targetPaneId` in `direction`, inserting a brand-new
 *  sibling leaf holding `content` immediately after it (the "split
 *  right"/"split down" header buttons — always a same-content-type
 *  sibling, per the spec; the caller constructs `content` via the factory
 *  functions above). */
export function splitPane(
  root: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  content: PaneContent,
): PaneNode {
  const newLeaf: LeafPane = { type: 'leaf', id: generateId(), tabs: [content], activeTabId: content.id }
  return insertLeafAdjacent(root, targetPaneId, direction, newLeaf, 'after')
}

export function splitLeaf(
  layout: WorktreeLayout,
  paneId: string,
  direction: SplitDirection,
  content: PaneContent,
): WorktreeLayout {
  const root = splitPane(layout.root, paneId, direction, content)
  return root === layout.root ? layout : { ...layout, root }
}

// ---------------------------------------------------------------------------
// close (with single-child-collapse)
// ---------------------------------------------------------------------------

export function removeContent(root: PaneNode, paneId: string, contentId: string): PaneNode | null {
  return removeContentFromNode(root, paneId, contentId)
}

/** Closes one tab from a pane, applying the collapse invariant. If closing
 *  the tab would empty the entire tree (the last tab of the last leaf),
 *  this is a defensive no-op — the UI layer is expected to never allow
 *  that (a worktree always keeps at least its primary Terminal pane). If
 *  the closed tab's pane was focused and got collapsed away, focus falls
 *  back to the tree's first leaf. */
export function closeTab(layout: WorktreeLayout, paneId: string, contentId: string): WorktreeLayout {
  const nextRoot = removeContentFromNode(layout.root, paneId, contentId)
  if (nextRoot === null || nextRoot === layout.root) return layout
  const focusedPaneId = findPane(nextRoot, layout.focusedPaneId)
    ? layout.focusedPaneId
    : (firstLeafId(nextRoot) ?? layout.focusedPaneId)
  return { ...layout, root: nextRoot, focusedPaneId }
}

// ---------------------------------------------------------------------------
// move / merge a tab between leaves (drag-and-drop commit)
// ---------------------------------------------------------------------------

/** Commits a drag-and-drop drop: moves `contentId` out of `sourcePaneId`
 *  and into `targetPaneId` per the 5-zone rule from the spec. `center`
 *  merges as a new tab into the target leaf (no structural change);
 *  `left`/`right`/`top`/`bottom` remove the tab from its source and insert
 *  it as a new sibling leaf, splitting the target's parent (or wrapping
 *  the target) in the implied direction. A no-op if the content can't be
 *  found, or if source and target are the same pane and the drop wouldn't
 *  change anything (dropping a pane's only tab onto itself). */
export function moveTab(
  root: PaneNode,
  sourcePaneId: string,
  targetPaneId: string,
  contentId: string,
  zone: DropZone,
): PaneNode {
  const sourceLeaf = findPane(root, sourcePaneId)
  if (!sourceLeaf || sourceLeaf.type !== 'leaf') return root
  const content = sourceLeaf.tabs.find((t) => t.id === contentId)
  if (!content) return root

  if (zone === 'center') {
    if (sourcePaneId === targetPaneId) return root
    const targetLeaf = findPane(root, targetPaneId)
    if (!targetLeaf || targetLeaf.type !== 'leaf') return root
    const afterRemoval = removeContentFromNode(root, sourcePaneId, contentId)
    if (afterRemoval === null) return root
    return mergeContentIntoLeaf(afterRemoval, targetPaneId, content)
  }

  if (sourcePaneId === targetPaneId && sourceLeaf.tabs.length === 1) return root

  const direction: SplitDirection = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const position: 'before' | 'after' = zone === 'left' || zone === 'top' ? 'before' : 'after'
  const afterRemoval = removeContentFromNode(root, sourcePaneId, contentId)
  if (afterRemoval === null) return root
  const newLeaf: LeafPane = { type: 'leaf', id: generateId(), tabs: [content], activeTabId: content.id }
  return insertLeafAdjacent(afterRemoval, targetPaneId, direction, newLeaf, position)
}

export function moveTabInLayout(
  layout: WorktreeLayout,
  sourcePaneId: string,
  targetPaneId: string,
  contentId: string,
  zone: DropZone,
): WorktreeLayout {
  const root = moveTab(layout.root, sourcePaneId, targetPaneId, contentId, zone)
  if (root === layout.root) return layout
  const focusedPaneId = findPane(root, layout.focusedPaneId)
    ? layout.focusedPaneId
    : (firstLeafId(root) ?? layout.focusedPaneId)
  return { ...layout, root, focusedPaneId }
}

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

/** Replaces a split's `sizes`. A no-op if `splitId` doesn't resolve to a
 *  `SplitPane`, `sizes.length` doesn't match `children.length`, or any
 *  size is non-positive; otherwise the given sizes are renormalized to sum
 *  to 1 (a `ResizeHandle` drag may not land exactly on 1 due to pointer
 *  rounding). */
export function resizeSplit(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  return mapTree(
    root,
    (n) => n.type === 'split' && n.id === splitId,
    (n) => {
      const split = n as SplitPane
      if (sizes.length !== split.children.length) return split
      if (sizes.some((s) => !(s > 0))) return split
      return { ...split, sizes: renormalizeSizes(sizes) }
    },
  )
}

export function resizeSplitInLayout(layout: WorktreeLayout, splitId: string, sizes: number[]): WorktreeLayout {
  const root = resizeSplit(layout.root, splitId, sizes)
  return root === layout.root ? layout : { ...layout, root }
}

// ---------------------------------------------------------------------------
// serialize / deserialize (persistence)
// ---------------------------------------------------------------------------

/** Deep-clones a layout into a plain JSON-safe value, ready to hand to
 *  `useLoomStore`'s `zustand/persist` slice. */
export function serializeLayout(layout: WorktreeLayout): WorktreeLayout {
  return JSON.parse(JSON.stringify(layout)) as WorktreeLayout
}

/** Light shape check for a value read back from `localStorage` — mirrors
 *  the spec's "Reading a layout" rule exactly: reject anything that isn't
 *  `version: 1` with a `root`, rather than trusting persisted client JSON.
 *  Callers should fall back to `createDefaultLayout` on `null`. */
export function deserializeLayout(value: unknown): WorktreeLayout | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WorktreeLayout>
  if (candidate.version !== 1 || !candidate.root) return null
  if (typeof candidate.focusedPaneId !== 'string') return null
  if (typeof candidate.nextTerminalSeq !== 'number') return null
  return candidate as WorktreeLayout
}
