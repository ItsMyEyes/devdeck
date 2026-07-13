# Workspace Tile Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a desktop tab be dragged to split the content area, so two or more worktrees' terminal views are visible and usable at once, via a new tiling engine isolated from (but closely modeled on) the existing per-worktree pane system.

**Architecture:** A new pure data-model module (`tileTree.ts`) is a close, isolated adaptation of the existing `paneTree.ts` engine, scoped to one leaf-content kind (a tab: the pinned Agents tab, or a worktree ref). A new React rendering/DnD component (`WorkspaceTileCanvas.tsx`) is a close, isolated adaptation of `PaneCanvas.tsx`. A wrapper component (`WorkspaceTileArea.tsx`) wires the store and router to that canvas, replacing the previously-shipped flat `TabBar.tsx`, which is deleted. The store gains a `workspaceTileLayouts` slice replacing `openTabs`.

**Tech Stack:** React 19, TanStack Router, zustand + immer + persist, `@dnd-kit/core`, Tailwind v4.

## Global Constraints

- Desktop (Tauri) only — gated by the existing `useIsTauri()` hook (`frontend/src/features/tabs/useIsTauri.ts`), reused unchanged. The web app must render exactly as it does today.
- `frontend/src/store/useLoomStore.ts` and `frontend/src/routes/w.$wsId.tsx` are project convergence files (root `CLAUDE.md`) — each is touched by exactly one task below.
- No test runner exists in `frontend/` — verification is `npm run typecheck` + `npm run build` + manual verification in `make dev-tauri`, matching every prior task in this feature.
- `tileTree.ts`/`WorkspaceTileCanvas.tsx` must not import from `../terminal/paneTree.ts` or `../terminal/PaneCanvas.tsx` — full isolation from the per-worktree engine is the entire point of this design (see the spec's "Why a separate engine" section). Where logic is identical (the 5-zone drop math, the collapse/resize algorithms), it is copied and adapted, not imported.
- The pinned Agents tab (`{ kind: 'agents'; id: 'agents' }`) is never closable and never duplicated — every function that touches tabs must preserve this invariant.
- `openWorktreeTab(wsId, projectId, wtId)` / `closeWorktreeTab(wsId, wtId)` / `pruneWorktreeTabs(wsId, liveWtIds)` keep their exact existing signatures — `WorktreeCard.tsx`, `SpawnDialog.tsx`, and `ProjectTree.tsx` call these today and must not need any changes.
- Bumping the store's persist version must not lose `worktreeLayouts` or `railExpanded` — verified against zustand's docs that a bare version bump with no `migrate` function discards the *entire* persisted blob, so an explicit `migrate` function is required (see Task 3).

---

### Task 1: `tileTree.ts` — pure tiling data model

**Files:**
- Create: `frontend/src/features/tabs/tileTree.ts`

**Interfaces:**
- Consumes: nothing (standalone pure module, only uses `crypto.randomUUID`/`Math.random` as a fallback id source, matching `frontend/src/features/terminal/paneTree.ts`'s own `generateId`).
- Produces (used by Tasks 2, 3, 4):
  - Types: `TileTab`, `TileLeaf`, `TileSplitDirection`, `TileSplit`, `TileNode`, `WorkspaceTileLayout`, `TileDropZone`.
  - `AGENTS_TAB: TileTab`
  - `createWorktreeTab(projectId: string, wtId: string): TileTab`
  - `createDefaultTileLayout(): WorkspaceTileLayout`
  - `firstLeafId(node: TileNode): string | undefined`
  - `findTileLeaf(root: TileNode, leafId: string): TileNode | undefined`
  - `findTileTab(root: TileNode, tabId: string): TileTab | undefined`
  - `findLeafForTab(root: TileNode, tabId: string): TileLeaf | undefined`
  - `focusTileLeaf(layout: WorkspaceTileLayout, leafId: string): WorkspaceTileLayout`
  - `selectTileTab(layout: WorkspaceTileLayout, leafId: string, tabId: string): WorkspaceTileLayout`
  - `openTileTab(layout: WorkspaceTileLayout, tab: TileTab): WorkspaceTileLayout`
  - `closeTileTab(layout: WorkspaceTileLayout, leafId: string, tabId: string): WorkspaceTileLayout`
  - `moveTileTab(root: TileNode, sourceLeafId: string, targetLeafId: string, tabId: string, zone: TileDropZone): TileNode`
  - `resizeTileSplit(root: TileNode, splitId: string, sizes: number[]): TileNode`
  - `pruneTileTabs(layout: WorkspaceTileLayout, liveWtIds: Set<string>): WorkspaceTileLayout`
  - `deserializeTileLayout(value: unknown): WorkspaceTileLayout | null`

- [ ] **Step 1: Write `tileTree.ts`**

```ts
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
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (Nothing imports this file yet, so this only validates its own internal types.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/tabs/tileTree.ts
git commit -m "feat(tabs): add tileTree, the workspace-level tiling data model"
```

---

### Task 2: `WorkspaceTileCanvas.tsx` — tiling rendering + drag-and-drop

**Files:**
- Create: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`

**Interfaces:**
- Consumes: `TileNode`/`TileLeaf`/`TileSplit`/`TileTab`/`TileDropZone`/`firstLeafId`/`findTileTab`/`moveTileTab`/`resizeTileSplit` from Task 1's `./tileTree`.
- Produces (used by Task 4):
  - `export interface WorkspaceTileCanvasProps` (below)
  - `export function WorkspaceTileCanvas(props: WorkspaceTileCanvasProps): JSX.Element`

- [ ] **Step 1: Write `WorkspaceTileCanvas.tsx`**

```tsx
import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { LayoutGrid, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { findTileTab, firstLeafId, moveTileTab, resizeTileSplit } from './tileTree'
import type { TileDropZone, TileLeaf, TileNode, TileSplit, TileTab } from './tileTree'

/** A split's children never shrink below this fraction of the split's axis while dragging a divider. */
const MIN_PANE_SIZE = 0.08
/** Reserved on the left for macOS's overlaid traffic-light buttons
 *  (tauri.macos.conf.json's titleBarStyle: "Overlay") — fused into
 *  whichever leaf renders in the tiling grid's actual top-left corner. */
const TRAFFIC_LIGHT_GUTTER = 76

export type WorktreeTileTab = Extract<TileTab, { kind: 'worktree' }>

export interface WorkspaceTileCanvasProps {
  root: TileNode
  renderers: {
    agents: (ctx: { leafId: string }) => ReactNode
    worktree: (ctx: { leafId: string; tab: WorktreeTileTab }) => ReactNode
  }
  /** Fired for every structural change this component makes itself: drag-and-drop commits and divider-resize commits. */
  onTreeChange: (root: TileNode) => void
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  /** Live label/status-color for a worktree tab, resolved by the caller
   *  from react-query data (not stored statically, since a worktree's
   *  branch/state can change while its tab stays open). `undefined` hides
   *  the tab (e.g. a worktree deleted right before pruning catches up). */
  resolveWorktreeTab: (tab: WorktreeTileTab) => { label: string; color: string; pulse: boolean } | undefined
  className?: string
}

interface TileRenderContext {
  topLeftLeafId: string
  renderers: WorkspaceTileCanvasProps['renderers']
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  hoverZone: { leafId: string; zone: TileDropZone } | null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Bucket a drop point (normalized to the target rect) into one of the 5 zones. Ties (a corner
 *  satisfying both an x-edge and a y-edge) go to whichever axis's value is closer to its edge. */
function computeDropZone(dx: number, dy: number): TileDropZone {
  const xEdge: TileDropZone | null = dx < 0.25 ? 'left' : dx > 0.75 ? 'right' : null
  const yEdge: TileDropZone | null = dy < 0.25 ? 'top' : dy > 0.75 ? 'bottom' : null
  if (xEdge && yEdge) {
    return Math.min(dx, 1 - dx) <= Math.min(dy, 1 - dy) ? xEdge : yEdge
  }
  return xEdge ?? yEdge ?? 'center'
}

function resolveHover(event: DragMoveEvent | DragEndEvent): { leafId: string; zone: TileDropZone } | null {
  const { active, over } = event
  if (!over) return null
  const data = over.data.current as { leafId?: string; forceCenter?: boolean } | undefined
  const leafId = data?.leafId ?? String(over.id)
  // A leaf's header (its tab strip) is where tabs visually live — dropping directly on it
  // always means "put this tab here" (merge as a new tab), regardless of pointer position.
  if (data?.forceCenter) return { leafId, zone: 'center' }
  const translated = active.rect.current.translated
  if (!translated || !over.rect.width || !over.rect.height) return null
  const centerX = translated.left + translated.width / 2
  const centerY = translated.top + translated.height / 2
  const dx = clamp01((centerX - over.rect.left) / over.rect.width)
  const dy = clamp01((centerY - over.rect.top) / over.rect.height)
  return { leafId, zone: computeDropZone(dx, dy) }
}

function zoneStyle(zone: TileDropZone): CSSProperties {
  switch (zone) {
    case 'left':
      return { top: 0, left: 0, bottom: 0, width: '25%' }
    case 'right':
      return { top: 0, right: 0, bottom: 0, width: '25%' }
    case 'top':
      return { top: 0, left: 0, right: 0, height: '25%' }
    case 'bottom':
      return { bottom: 0, left: 0, right: 0, height: '25%' }
    default:
      return { top: '25%', left: '25%', right: '25%', bottom: '25%' }
  }
}

/** Recursive dispatcher: a degenerate split (<2 children) renders its one remaining child in
 *  place, an empty leaf renders nothing (defensive — should never happen given the Agents tab
 *  is never closable). */
function TileNodeView({ node, ctx }: { node: TileNode; ctx: TileRenderContext }) {
  if (node.type === 'leaf') {
    if (node.tabs.length === 0) return null
    return <TileLeafView leaf={node} ctx={ctx} />
  }
  if (node.children.length === 0) return null
  if (node.children.length === 1) return <TileNodeView node={node.children[0]} ctx={ctx} />
  return <TileSplitView node={node} ctx={ctx} />
}

function TileSplitView({ node, ctx }: { node: TileSplit; ctx: TileRenderContext }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ index: number; startSizes: number[]; startPos: number; containerSize: number } | null>(
    null,
  )
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null)

  const isRow = node.direction === 'row'
  const sizes = liveSizes ?? node.sizes

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.containerSize <= 0) return
    const pos = isRow ? event.clientX : event.clientY
    const deltaFrac = (pos - drag.startPos) / drag.containerSize
    const a = drag.startSizes[drag.index]
    const b = drag.startSizes[drag.index + 1]
    const clampedDelta = Math.min(Math.max(deltaFrac, MIN_PANE_SIZE - a), b - MIN_PANE_SIZE)
    const next = [...drag.startSizes]
    next[drag.index] = a + clampedDelta
    next[drag.index + 1] = b - clampedDelta
    setLiveSizes(next)
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setLiveSizes((current) => {
      if (current) ctx.onResizeSplit(node.id, current)
      return null
    })
  }

  return (
    <div ref={containerRef} className={cn('flex min-h-0 min-w-0 flex-1', isRow ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 ? (
            <div
              role="separator"
              aria-orientation={isRow ? 'vertical' : 'horizontal'}
              className={cn(
                'flex-none touch-none bg-loom-border transition-colors hover:bg-loom-accent active:bg-loom-accent',
                isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
              )}
              onPointerDown={(event) => {
                const container = containerRef.current
                if (!container) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                const rect = container.getBoundingClientRect()
                dragRef.current = {
                  index: i - 1,
                  startSizes: node.sizes,
                  startPos: isRow ? event.clientX : event.clientY,
                  containerSize: isRow ? rect.width : rect.height,
                }
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0 overflow-hidden"
            style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0, flexShrink: 1 }}
          >
            <TileNodeView node={child} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function TileTabButton({
  leafId,
  tab,
  active,
  resolveWorktreeTab,
  onSelect,
  onClose,
}: {
  leafId: string
  tab: TileTab
  active: boolean
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  onSelect: () => void
  onClose?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { tabId: tab.id, sourceLeafId: leafId },
  })

  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex h-7 max-w-[180px] flex-none touch-none cursor-grab items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 font-mono text-[11.5px] active:cursor-grabbing',
      active ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
      dragging && 'opacity-40',
    )

  if (tab.kind === 'worktree') {
    const info = resolveWorktreeTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <StatusDot color={info.color} pulse={info.pulse} />
          <span className="truncate">{info.label}</span>
        </button>
        {onClose ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            aria-label={`Close ${info.label}`}
            className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
          >
            <X size={11} />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
        <LayoutGrid size={12} />
        <span className="truncate">Agents</span>
      </button>
    </div>
  )
}

function TileLeafView({ leaf, ctx }: { leaf: TileLeaf; ctx: TileRenderContext }) {
  const { setNodeRef } = useDroppable({ id: leaf.id, data: { leafId: leaf.id } })
  const { setNodeRef: setHeaderDropRef } = useDroppable({
    id: `${leaf.id}::header`,
    data: { leafId: leaf.id, forceCenter: true },
  })
  const hoverZone = ctx.hoverZone && ctx.hoverZone.leafId === leaf.id ? ctx.hoverZone.zone : null
  const isTopLeft = leaf.id === ctx.topLeftLeafId

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onPointerDownCapture={() => ctx.onFocusLeaf(leaf.id)}>
      <div
        ref={setHeaderDropRef}
        className="flex h-10 flex-none items-center overflow-x-auto border-b border-loom-border bg-loom-surface"
      >
        {isTopLeft ? (
          <div data-tauri-drag-region className="h-full flex-none" style={{ width: TRAFFIC_LIGHT_GUTTER }} />
        ) : null}
        {leaf.tabs.map((tab) => (
          <TileTabButton
            key={tab.id}
            leafId={leaf.id}
            tab={tab}
            active={tab.id === leaf.activeTabId}
            resolveWorktreeTab={ctx.resolveWorktreeTab}
            onSelect={() => ctx.onSelectTab(leaf.id, tab.id)}
            onClose={tab.kind === 'worktree' ? () => ctx.onCloseTab(leaf.id, tab.id) : undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => ctx.onNewTab(leaf.id)}
          aria-label="New worktree"
          className="ml-1 flex h-7 w-7 flex-none items-center justify-center rounded-lg text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg"
        >
          <Plus size={13} />
        </button>
        <div data-tauri-drag-region className="h-full flex-1" />
      </div>
      <div ref={setNodeRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {leaf.tabs.map((tab) => (
          <div key={tab.id} className={cn('absolute inset-0', tab.id === leaf.activeTabId ? 'flex' : 'hidden')}>
            {tab.kind === 'agents' ? ctx.renderers.agents({ leafId: leaf.id }) : ctx.renderers.worktree({ leafId: leaf.id, tab })}
          </div>
        ))}
        {hoverZone ? (
          <div
            className="pointer-events-none absolute z-10 border-2 border-loom-accent bg-loom-accent/15"
            style={zoneStyle(hoverZone)}
          />
        ) : null}
      </div>
    </div>
  )
}

/** Renders a `TileNode` tree as a resizable tiling canvas and wires up drag-and-drop tab
 *  rearrangement (5-zone edge/center detection, `DragOverlay` preview, live drop-zone
 *  highlight) — an isolated adaptation of `../terminal/PaneCanvas.tsx` for one leaf-content
 *  kind (a tab reference) instead of Terminal/Git/File/Explorer content. Every mutation this
 *  component makes to the tree — divider resize commits and DnD drops — goes through
 *  `onTreeChange`; everything else (tab select/close/new, leaf focus) is delegated to the
 *  matching callback prop. */
export function WorkspaceTileCanvas({
  root,
  renderers,
  onTreeChange,
  onFocusLeaf,
  onSelectTab,
  onCloseTab,
  onNewTab,
  resolveWorktreeTab,
  className,
}: WorkspaceTileCanvasProps) {
  const [dragTab, setDragTab] = useState<TileTab | null>(null)
  const [hoverZone, setHoverZone] = useState<{ leafId: string; zone: TileDropZone } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const topLeftLeafId = useMemo(() => firstLeafId(root) ?? root.id, [root])

  const handleResizeSplit = useCallback(
    (splitId: string, sizes: number[]) => {
      const next = resizeTileSplit(root, splitId, sizes)
      if (next !== root) onTreeChange(next)
    },
    [root, onTreeChange],
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDragTab(findTileTab(root, String(event.active.id)) ?? null)
    },
    [root],
  )

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setHoverZone(resolveHover(event))
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragTab(null)
      setHoverZone(null)
      const { active, over } = event
      if (!over) return
      const data = active.data.current as { tabId?: string; sourceLeafId?: string } | undefined
      const sourceLeafId = data?.sourceLeafId
      if (!sourceLeafId) return
      const tabId = data?.tabId ?? String(active.id)
      const resolved = resolveHover(event)
      if (!resolved) return
      const next = moveTileTab(root, sourceLeafId, resolved.leafId, tabId, resolved.zone)
      if (next !== root) onTreeChange(next)
    },
    [root, onTreeChange],
  )

  const handleDragCancel = useCallback(() => {
    setDragTab(null)
    setHoverZone(null)
  }, [])

  const ctx: TileRenderContext = {
    topLeftLeafId,
    renderers,
    onFocusLeaf,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onResizeSplit: handleResizeSplit,
    resolveWorktreeTab,
    hoverZone,
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
        <TileNodeView node={root} ctx={ctx} />
      </div>
      <DragOverlay>
        {dragTab ? (
          <div className="flex h-8 max-w-[200px] items-center gap-1.5 rounded border border-loom-border bg-loom-terminal px-3 font-mono text-[11px] text-loom-fg shadow-[0_10px_28px_rgba(0,0,0,0.5)]">
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} />
            ) : (
              <StatusDot color={resolveWorktreeTab(dragTab)?.color ?? '#6b7280'} />
            )}
            <span className="truncate">
              {dragTab.kind === 'agents' ? 'Agents' : (resolveWorktreeTab(dragTab)?.label ?? dragTab.wtId)}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (Not imported anywhere yet, so this only validates its own types against Task 1's exports.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx
git commit -m "feat(tabs): add WorkspaceTileCanvas, the tiling render/DnD layer"
```

---

### Task 3: Store — replace `openTabs` with `workspaceTileLayouts`

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts`

**Interfaces:**
- Consumes: `WorkspaceTileLayout`, `closeTileTab`, `createDefaultTileLayout`, `createWorktreeTab`, `findLeafForTab`, `openTileTab`, `pruneTileTabs` from Task 1's `@/features/tabs/tileTree`.
- Produces (used by Task 4):
  - `workspaceTileLayouts: Record<string, WorkspaceTileLayout>` on `LoomState`.
  - `openWorktreeTab(wsId, projectId, wtId)` / `closeWorktreeTab(wsId, wtId)` / `pruneWorktreeTabs(wsId, liveWtIds)` — same signatures as before, now backed by the tile tree.
  - `setWorkspaceTileLayout(wsId: string, layout: WorkspaceTileLayout): void` — new, generic setter for tree-structural commits (DnD drops, resizes) that Task 4 computes via Task 1's pure functions before calling this.

- [ ] **Step 1: Remove `WorktreeTabRef` and add the `tileTree` import**

Replace (lines 1-21):

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type { WorktreeLayout } from '@/features/terminal/paneTree'
import type {
  Priority,
  Project,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine'
export type TodoFilter = 'all' | 'active' | 'done'
export type NewProjectMode = 'local' | 'clone'
export type BrowseTarget = 'newPath' | 'cloneParent' | 'edit'

export interface WorktreeTabRef {
  projectId: string
  wtId: string
}
```

with:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type { WorktreeLayout } from '@/features/terminal/paneTree'
import {
  closeTileTab,
  createDefaultTileLayout,
  createWorktreeTab,
  findLeafForTab,
  openTileTab,
  pruneTileTabs,
} from '@/features/tabs/tileTree'
import type { WorkspaceTileLayout } from '@/features/tabs/tileTree'
import type {
  Priority,
  Project,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine'
export type TodoFilter = 'all' | 'active' | 'done'
export type NewProjectMode = 'local' | 'clone'
export type BrowseTarget = 'newPath' | 'cloneParent' | 'edit'
```

- [ ] **Step 2: Replace the `openTabs` field with `workspaceTileLayouts`**

Replace (the `railExpanded`/`openTabs` block inside `LoomState`):

```ts
  railExpanded: boolean
  /** Chrome-style desktop tab bar (Tauri only): worktrees currently open as
   *  tabs, per workspace, in open order. Unused by the web app. */
  openTabs: Record<string, WorktreeTabRef[]>
```

with:

```ts
  railExpanded: boolean
  /** Chrome-style desktop tab bar (Tauri only): each workspace's tiling
   *  tree of open worktree tabs (splits, per-leaf tab strips). Unused by
   *  the web app. */
  workspaceTileLayouts: Record<string, WorkspaceTileLayout>
```

- [ ] **Step 3: Add `setWorkspaceTileLayout` to the action signatures**

Change:

```ts
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
```

to:

```ts
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void
```

- [ ] **Step 4: Replace the initial state and the three action implementations**

Change:

```ts
      railExpanded: false,
      openTabs: {},
```

to:

```ts
      railExpanded: false,
      workspaceTileLayouts: {},
```

Change:

```ts
      openWorktreeTab: (wsId, projectId, wtId) =>
        set((s) => {
          if (!s.openTabs[wsId]) s.openTabs[wsId] = []
          const tabs = s.openTabs[wsId]
          if (!tabs.some((t) => t.wtId === wtId)) tabs.push({ projectId, wtId })
        }),
      closeWorktreeTab: (wsId, wtId) =>
        set((s) => void (s.openTabs[wsId] = (s.openTabs[wsId] ?? []).filter((t) => t.wtId !== wtId))),
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => void (s.openTabs[wsId] = (s.openTabs[wsId] ?? []).filter((t) => liveWtIds.has(t.wtId)))),
```

to:

```ts
      setWorkspaceTileLayout: (wsId, layout) => set((s) => void (s.workspaceTileLayouts[wsId] = layout)),
      openWorktreeTab: (wsId, projectId, wtId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, createWorktreeTab(projectId, wtId))
        }),
      closeWorktreeTab: (wsId, wtId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          const leaf = findLeafForTab(layout.root, wtId)
          if (!leaf) return
          s.workspaceTileLayouts[wsId] = closeTileTab(layout, leaf.id, wtId)
        }),
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          s.workspaceTileLayouts[wsId] = pruneTileTabs(layout, liveWtIds)
        }),
```

- [ ] **Step 5: Bump the persist version with an explicit `migrate`, and update `partialize`**

Change:

```ts
    {
      name: 'loom-ui-v2',
      version: 2,
      // Persist only harmless UI preferences; no domain data ever touches
      // localStorage now that the backend is the source of truth.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        railExpanded: s.railExpanded,
        openTabs: s.openTabs,
      }),
    },
```

to:

```ts
    {
      name: 'loom-ui-v2',
      version: 3,
      // Persist only harmless UI preferences; no domain data ever touches
      // localStorage now that the backend is the source of truth.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        railExpanded: s.railExpanded,
        workspaceTileLayouts: s.workspaceTileLayouts,
      }),
      // v2 -> v3 retires the flat `openTabs` shape for `workspaceTileLayouts`.
      // A bare version bump with no `migrate` discards the *entire*
      // persisted blob, which would also wipe the unrelated
      // `worktreeLayouts`/`railExpanded` — so this carries those two
      // forward unchanged and only drops the old `openTabs` key.
      migrate: (persisted) => {
        const old = persisted as {
          sidebarOpen?: boolean
          worktreeLayouts?: Record<string, WorktreeLayout>
          railExpanded?: boolean
        }
        return {
          sidebarOpen: old.sidebarOpen ?? false,
          worktreeLayouts: old.worktreeLayouts ?? {},
          railExpanded: old.railExpanded ?? false,
          workspaceTileLayouts: {},
        } as LoomState
      },
    },
```

- [ ] **Step 6: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useLoomStore.ts
git commit -m "feat(store): replace openTabs with workspaceTileLayouts"
```

---

### Task 4: `WorkspaceTileArea.tsx` — wires the store and router to the canvas

**Files:**
- Create: `frontend/src/features/tabs/WorkspaceTileArea.tsx`

**Interfaces:**
- Consumes: `WorkspaceTileCanvas` (Task 2); `workspaceTileLayouts`/`setWorkspaceTileLayout`/`closeWorktreeTab`/`pruneWorktreeTabs`/`openSpawn`/`showToast` (Task 3, via `useLoomStore`); `createDefaultTileLayout`/`findTileLeaf`/`findTileTab`/`firstLeafId`/`focusTileLeaf`/`selectTileTab` (Task 1's `tileTree`); `useWorkspace` (`@/features/data/queries`); `WorktreeCardsGrid` (`@/features/agents/WorktreeCardsGrid`); `ExpandedTerminal` (`@/features/terminal/ExpandedTerminal`); `STATE` (`@/lib/constants`).
- Produces (used by Task 5): `export function WorkspaceTileArea({ wsId }: { wsId: string }): JSX.Element`

- [ ] **Step 1: Write `WorkspaceTileArea.tsx`**

```tsx
import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useWorkspace } from '@/features/data/queries'
import { STATE } from '@/lib/constants'
import { useLoomStore } from '@/store/useLoomStore'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import { createDefaultTileLayout, findTileLeaf, findTileTab, firstLeafId, focusTileLeaf, selectTileTab } from './tileTree'
import type { TileTab, WorkspaceTileLayout } from './tileTree'
import type { WorktreeTileTab } from './WorkspaceTileCanvas'

interface WorkspaceTileAreaProps {
  wsId: string
}

/** Wires `WorkspaceTileCanvas` to the store (persisted tiling tree) and the
 *  router (URL follows the focused leaf's active worktree). Supersedes the
 *  previously-shipped flat `TabBar` — a single leaf with no splits *is*
 *  what that looked like. */
export function WorkspaceTileArea({ wsId }: WorkspaceTileAreaProps) {
  const navigate = useNavigate()
  const { projectId: currentProjectId } = useParams({ strict: false }) as { projectId?: string }
  const layout = useLoomStore((s) => s.workspaceTileLayouts[wsId]) ?? createDefaultTileLayout()
  const setWorkspaceTileLayout = useLoomStore((s) => s.setWorkspaceTileLayout)
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []

  function commit(next: WorkspaceTileLayout) {
    setWorkspaceTileLayout(wsId, next)
  }

  function navigateToTab(tab: TileTab) {
    if (tab.kind === 'agents') {
      navigate({ to: '/w/$wsId', params: { wsId } })
    } else {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
      })
    }
  }

  // Drop tabs for worktrees deleted while the app was closed (or by another tab).
  useEffect(() => {
    if (!workspace) return
    pruneWorktreeTabs(wsId, new Set(worktrees.map((w) => w.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, wsId])

  function handleFocusLeaf(leafId: string) {
    const next = focusTileLeaf(layout, leafId)
    if (next === layout) return
    commit(next)
    const leaf = findTileLeaf(next.root, leafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  function handleSelectTab(leafId: string, tabId: string) {
    commit(selectTileTab(layout, leafId, tabId))
    const tab = findTileTab(layout.root, tabId)
    if (tab) navigateToTab(tab)
  }

  function handleCloseTab(_leafId: string, tabId: string) {
    closeWorktreeTab(wsId, tabId)
    const next = useLoomStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  function handleNewTab(leafId: string) {
    const targetProjectId = currentProjectId ?? workspace?.projects[0]?.id
    if (!targetProjectId) {
      showToast('Add a project first')
      return
    }
    commit(focusTileLeaf(layout, leafId))
    openSpawn(targetProjectId)
  }

  // `WorkspaceTileCanvas.onTreeChange` only ever hands back the new `root`
  // (used for both DnD-drop commits and divider-resize commits) — a drop
  // can collapse the currently-focused leaf away, so `focusedLeafId` is
  // recomputed here rather than carried over unchanged, mirroring how
  // `../terminal/ExpandedTerminal.tsx` commits `PaneCanvas`'s `onTreeChange`.
  function handleTreeChange(root: WorkspaceTileLayout['root']) {
    const focusedLeafId = findTileLeaf(root, layout.focusedLeafId)
      ? layout.focusedLeafId
      : (firstLeafId(root) ?? layout.focusedLeafId)
    commit({ ...layout, root, focusedLeafId })
  }

  function resolveWorktreeTab(tab: WorktreeTileTab) {
    const worktree = worktrees.find((w) => w.id === tab.wtId)
    if (!worktree) return undefined
    const st = STATE[worktree.state]
    return {
      label: worktree.root ? 'project root' : worktree.branch,
      color: st.color,
      pulse: worktree.state === 'running' || worktree.state === 'waiting',
    }
  }

  // Cmd+W closes the focused leaf's active tab (no-op on the Agents tab);
  // Cmd+Shift+[ / Cmd+Shift+] cycle the focused leaf's own tab strip —
  // scoped per-leaf now that tabs live inside panes instead of one global
  // strip. metaKey only, matching the flat TabBar's prior shortcuts — see
  // that spec's decision 9 for why ctrlKey would collide with
  // ExpandedTerminal's own Ctrl+T/Ctrl+W handler.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!event.metaKey) return
      const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
      if (!leaf || leaf.type !== 'leaf') return

      if (event.key.toLowerCase() === 'w') {
        if (leaf.activeTabId === 'agents') return
        event.preventDefault()
        handleCloseTab(leaf.id, leaf.activeTabId)
        return
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const idx = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId)
        const delta = event.key === ']' ? 1 : -1
        const nextTab = leaf.tabs[(idx + delta + leaf.tabs.length) % leaf.tabs.length]
        if (nextTab) handleSelectTab(leaf.id, nextTab.id)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  return (
    <WorkspaceTileCanvas
      root={layout.root}
      renderers={{
        agents: () => {
          const project = workspace?.projects.find((p) => p.id === (currentProjectId ?? workspace.projects[0]?.id))
          if (!project) return null
          return <WorktreeCardsGrid project={project} wsId={wsId} />
        },
        worktree: ({ tab }) => {
          const worktree = worktrees.find((w) => w.id === tab.wtId)
          if (!worktree) return null
          return <ExpandedTerminal worktree={worktree} wsId={wsId} projectId={tab.projectId} />
        },
      }}
      onTreeChange={handleTreeChange}
      onFocusLeaf={handleFocusLeaf}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      resolveWorktreeTab={resolveWorktreeTab}
      className="min-h-0"
    />
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (Not mounted anywhere yet, so this only validates its own types against Tasks 1-3's exports.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileArea.tsx
git commit -m "feat(tabs): add WorkspaceTileArea, wiring the tile canvas to the store and router"
```

---

### Task 5: Mount `WorkspaceTileArea`, retire `TabBar`, verify end-to-end

**Files:**
- Modify: `frontend/src/routes/w.$wsId.tsx`
- Delete: `frontend/src/features/tabs/TabBar.tsx`

**Interfaces:**
- Consumes: `WorkspaceTileArea` (Task 4), `useIsTauri` (existing, unchanged).
- Produces: nothing further downstream — this is the integration task.

- [ ] **Step 1: Swap the `TabBar` import for `WorkspaceTileArea`, add the agents-scope route pattern**

In `frontend/src/routes/w.$wsId.tsx`, change the import block (currently):

```ts
import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { useSettings, useUpdateSettings, useWorkspaces } from '@/features/data/queries'
import { Header } from '@/features/layout/Header'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { GlobalOverlays } from '@/features/overlays/GlobalOverlays'
import { TabBar } from '@/features/tabs/TabBar'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { useLoomStore } from '@/store/useLoomStore'

/** Matches only the worktree route, e.g. /w/abc/p/def/wt/ghi (the ExpandedTerminal screen). */
const WORKSPACE_MODE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+\/wt\/[^/]+/
```

to:

```ts
import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { useSettings, useUpdateSettings, useWorkspaces } from '@/features/data/queries'
import { Header } from '@/features/layout/Header'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { GlobalOverlays } from '@/features/overlays/GlobalOverlays'
import { WorkspaceTileArea } from '@/features/tabs/WorkspaceTileArea'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { cn } from '@/lib/utils'
import { useLoomStore } from '@/store/useLoomStore'

/** Matches only the worktree route, e.g. /w/abc/p/def/wt/ghi (the ExpandedTerminal screen). */
const WORKSPACE_MODE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+\/wt\/[^/]+/
/** Matches the Agents grid or a worktree terminal — the two routes
 *  `WorkspaceTileArea` renders itself, bypassing `<Outlet/>`, once tiling
 *  is active. Every other workspace route (Machines, Tools, News, ...)
 *  keeps rendering via `<Outlet/>` as before. */
const AGENTS_SCOPE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+(\/wt\/[^/]+)?$/
```

- [ ] **Step 2: Render `WorkspaceTileArea` (always mounted, CSS-hidden outside its scope) instead of `TabBar`, and stop `<Outlet/>` from double-rendering the same worktree**

Inside `WorkspaceLayout`, change:

```ts
  const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)
  const isTauri = useIsTauri()
```

to:

```ts
  const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)
  const isTauri = useIsTauri()
  const inTiledScope = isTauri && AGENTS_SCOPE_PATTERN.test(pathname)
```

Then change the render (currently):

```tsx
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden bg-loom-bg text-loom-fg">
      {isTauri && <TabBar wsId={wsId} />}
      {!workspaceMode && <Header />}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar compact={workspaceMode} />
        <section className="flex min-w-0 flex-1 flex-col bg-loom-bg">
          <Outlet />
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
```

to:

```tsx
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden bg-loom-bg text-loom-fg">
      {!workspaceMode && <Header />}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar compact={workspaceMode} />
        <section className="flex min-w-0 flex-1 flex-col bg-loom-bg">
          {isTauri ? (
            <div className={cn('flex min-h-0 flex-1 flex-col', !inTiledScope && 'hidden')}>
              <WorkspaceTileArea wsId={wsId} />
            </div>
          ) : null}
          {!inTiledScope ? <Outlet /> : null}
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
```

`WorkspaceTileArea` stays mounted at all times once `isTauri` (CSS-hidden via `hidden` outside the Agents-grid/worktree scope), so every `ExpandedTerminal` it holds — including ones in split panes — keeps its WebSocket session alive while browsing Machines/Tools/etc. `<Outlet/>` is only actually mounted when `!inTiledScope`, so on Tauri it never renders `TerminalRoute`/`CardsRoute` for the same worktree `WorkspaceTileArea` is already showing — avoiding a duplicate `ExpandedTerminal`/duplicate WebSocket connection for the focused worktree. On the web (`!isTauri`), `inTiledScope` is always `false`, so `<Outlet/>` renders unconditionally exactly as it does today.

- [ ] **Step 3: Delete the superseded `TabBar.tsx`**

```bash
rm frontend/src/features/tabs/TabBar.tsx
```

- [ ] **Step 4: Run typecheck and production build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both PASS with no errors. (`npm run build` will fail loudly with an unresolved-import error if anything still references the deleted `TabBar.tsx`.)

- [ ] **Step 5: Manual verification in the desktop app**

Run: `make dev-tauri` (from the repo root). Walk through, confirming each behavior from the design spec (`docs/superpowers/specs/2026-07-13-workspace-tile-splitting-design.md`):
1. On launch, a single pane shows just the pinned Agents tab — visually the same as the flat tab bar looked before this feature.
2. Open two worktree tabs (from the Agents grid, the sidebar's `ProjectTree`, and via the header's spawn dialog — all three paths). Drag one tab onto the other's content area, dropping on the right edge: the view splits side-by-side, both worktrees' terminals are live and independently typeable at the same time.
3. Drag a tab onto a pane's top/bottom edge instead: splits stacked. Drag onto a pane's center (or its tab strip): merges as a new tab in that pane instead of splitting.
4. Drag the pinned Agents tab into a split pane: it moves there (no duplicate), and its origin pane's other tabs stay put.
5. With a split active, click into the non-focused pane's terminal content (not just its tab): the URL updates to that pane's active worktree, and `Cmd+W`/`Cmd+Shift+[`/`Cmd+Shift+]` now act on that pane's strip.
6. Close tabs until a split collapses back down to a single pane; close a worktree tab and confirm (via the Agents grid's live status) its backend session keeps running, unaffected.
7. Click a pane's "+": the spawn dialog opens for the project currently in view; the created worktree becomes a new tab in that same pane.
8. Navigate to Machines (or any other sidebar module page) while a split is active: the split's terminals disappear from view but keep running — switch to a project's Terminal tab elsewhere, come back to Machines, then navigate back to the Agents grid and confirm the exact same split layout is still there, live, undisturbed.
9. Restart the app entirely and confirm the full split arrangement (not just which worktrees were open) is restored.
10. Delete a worktree that's part of a split, from the Agents grid: its tab (and, if it was that leaf's last tab, the leaf itself) is pruned on next load.
11. Run `make dev` (the web app) in a browser: confirm the Agents grid and worktree terminal routes render exactly as before (via `<Outlet/>`), with no tab bar and no tiling — fully unaffected by this feature.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/w.$wsId.tsx
git rm frontend/src/features/tabs/TabBar.tsx
git commit -m "feat(tabs): mount WorkspaceTileArea in place of the flat TabBar"
```
