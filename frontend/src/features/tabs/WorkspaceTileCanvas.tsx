import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { Globe, LayoutGrid, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { findTileLeaf, findTileTab, firstLeafId, moveTileTab, resizeTileSplit } from './tileTree'
import type { TileDropZone, TileLeaf, TileNode, TileSplit, TileTab } from './tileTree'

/** A split's children never shrink below this fraction of the split's axis while dragging a divider. */
const MIN_PANE_SIZE = 0.08
/** Reserved on the left for macOS's overlaid traffic-light buttons
 *  (tauri.macos.conf.json's titleBarStyle: "Overlay") — fused into
 *  whichever leaf renders in the tiling grid's actual top-left corner. */
const TRAFFIC_LIGHT_GUTTER = 76

export type WorktreeTileTab = Extract<TileTab, { kind: 'worktree' }>
export type BrowserTileTab = Extract<TileTab, { kind: 'browser' }>

export interface WorkspaceTileCanvasProps {
  root: TileNode
  renderers: {
    agents: (ctx: { leafId: string }) => ReactNode
    worktree: (ctx: { leafId: string; tab: WorktreeTileTab }) => ReactNode
    browser: (ctx: { leafId: string; tab: BrowserTileTab }) => ReactNode
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
   *  the tab (e.g. a worktree deleted right before pruning catches up).
   *  `short` is "project name · machine host" (machine omitted when local),
   *  used only for the computed workspace title, not the tab pill itself. */
  resolveWorktreeTab: (tab: WorktreeTileTab) => { label: string; color: string; pulse: boolean; short: string } | undefined
  /** Live title for a browser tab, resolved from the store's `browserTiles`
   *  slice (not stored in the tile tree itself). `undefined` hides the tab
   *  (mirrors `resolveWorktreeTab`'s contract). */
  resolveBrowserTab: (tab: BrowserTileTab) => { label: string } | undefined
  /** When `false`, only the top-left leaf's pinned header renders — no
   *  leaf bodies, no other leaves. Used on non-tiled workspace routes
   *  (Machines, Tools, Invoices, ...) so the tab strip stays up as
   *  persistent chrome while `<Outlet/>` takes over the content area
   *  below it. Defaults to `true` (render the full tree, as before). */
  showContent?: boolean
  className?: string
}

interface TileRenderContext {
  topLeftLeafId: string
  /** "Workspace (A + B)" summary shown in the pinned strip once a split
   *  exists; `null` while there's only one leaf (nothing to summarize). */
  workspaceTitle: string | null
  renderers: WorkspaceTileCanvasProps['renderers']
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  hoverZone: { leafId: string; zone: TileDropZone } | null
}

function collectLeaves(node: TileNode): TileLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

/** Short display name for whichever tab is active in a leaf — 'Agents' for
 *  the pinned home tab, otherwise the worktree's `short` (project ·
 *  machine). Used to build the "Workspace (A + B)" summary title. */
function leafShortTitle(
  leaf: TileLeaf,
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab'],
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab'],
): string {
  const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0]
  if (!tab) return ''
  if (tab.kind === 'agents') return 'Agents'
  if (tab.kind === 'browser') return resolveBrowserTab(tab)?.label ?? 'Browser'
  return resolveWorktreeTab(tab)?.short ?? tab.wtId
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
  compact,
  resolveWorktreeTab,
  resolveBrowserTab,
  onSelect,
  onClose,
}: {
  leafId: string
  tab: TileTab
  active: boolean
  /** Non-top-left leaves render a visually lighter strip so a split never
   *  reads as "two full tab strips stacked" — see TileLeafView. */
  compact: boolean
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  onSelect: () => void
  onClose?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { tabId: tab.id, sourceLeafId: leafId },
  })

  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex flex-none touch-none cursor-grab items-center gap-1.5 rounded-lg font-mono active:cursor-grabbing',
      compact ? 'h-6 max-w-[150px] pl-2 pr-1 text-[11px]' : 'h-7 max-w-[180px] pl-2.5 pr-1.5 text-[11.5px]',
      active ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
      dragging && 'opacity-40',
    )

  const closeButton = (label: string) =>
    onClose ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${label}`}
        className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    ) : null

  if (tab.kind === 'worktree') {
    const info = resolveWorktreeTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <StatusDot color={info.color} pulse={info.pulse} />
          <span className="truncate">{info.label}</span>
        </button>
        {closeButton(info.label)}
      </div>
    )
  }

  if (tab.kind === 'browser') {
    const info = resolveBrowserTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe size={12} />
          <span className="truncate">{info.label}</span>
        </button>
        {closeButton(info.label)}
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

/** A leaf's own header row: its tab strip. Extracted from `TileLeafView` so
 *  it can also render standalone (no body, no other leaves) as the
 *  persistent chrome on non-tiled workspace routes — see `showContent` on
 *  `WorkspaceTileCanvas`. */
function TileLeafHeader({ leaf, isTopLeft, ctx }: { leaf: TileLeaf; isTopLeft: boolean; ctx: TileRenderContext }) {
  const { setNodeRef: setHeaderDropRef } = useDroppable({
    id: `${leaf.id}::header`,
    data: { leafId: leaf.id, forceCenter: true },
  })

  return (
    <div
      ref={setHeaderDropRef}
      className={cn(
        'flex items-center overflow-x-auto border-b border-loom-border bg-loom-surface',
        isTopLeft
          ? // The top-left leaf's strip is pinned to the true viewport origin
            // (not just "first in flow") so it visually merges with macOS's
            // overlaid traffic-light buttons regardless of Header/Sidebar
            // nesting above/beside it — see w.$wsId.tsx's matching `pt-10`,
            // which reserves this exact height so nothing renders underneath.
            'fixed left-0 right-0 top-0 z-40 h-10'
          : // Every other leaf is a lightweight mini-header, not a second
            // full tab strip — shorter, no title text, no drag region.
            'h-8 flex-none',
      )}
    >
      {isTopLeft ? (
        <div data-tauri-drag-region className="h-full flex-none" style={{ width: TRAFFIC_LIGHT_GUTTER }} />
      ) : null}
      {leaf.tabs.map((tab, i) => (
        <Fragment key={tab.id}>
          <TileTabButton
            leafId={leaf.id}
            tab={tab}
            active={tab.id === leaf.activeTabId}
            compact={!isTopLeft}
            resolveWorktreeTab={ctx.resolveWorktreeTab}
            resolveBrowserTab={ctx.resolveBrowserTab}
            onSelect={() => ctx.onSelectTab(leaf.id, tab.id)}
            onClose={tab.kind !== 'agents' ? () => ctx.onCloseTab(leaf.id, tab.id) : undefined}
          />
          {/* Divider after the pinned Agents tab, matching the flat TabBar's original look. */}
          {tab.kind === 'agents' && i < leaf.tabs.length - 1 ? (
            <div className="mx-1.5 h-4 w-px flex-none bg-loom-border-menu" />
          ) : null}
        </Fragment>
      ))}
      <button
        type="button"
        onClick={() => ctx.onNewTab(leaf.id)}
        aria-label="New worktree"
        className={cn(
          'ml-1 flex flex-none items-center justify-center rounded-lg text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg',
          isTopLeft ? 'h-7 w-7' : 'h-6 w-6',
        )}
      >
        <Plus size={isTopLeft ? 13 : 11} />
      </button>
      {isTopLeft ? (
        <div data-tauri-drag-region className="flex h-full flex-1 items-center justify-center overflow-hidden px-2">
          {ctx.workspaceTitle ? (
            <span className="truncate font-mono text-[11px] text-loom-dim">{ctx.workspaceTitle}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TileLeafView({ leaf, ctx }: { leaf: TileLeaf; ctx: TileRenderContext }) {
  const { setNodeRef } = useDroppable({ id: leaf.id, data: { leafId: leaf.id } })
  const hoverZone = ctx.hoverZone && ctx.hoverZone.leafId === leaf.id ? ctx.hoverZone.zone : null
  const isTopLeft = leaf.id === ctx.topLeftLeafId

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onPointerDownCapture={() => ctx.onFocusLeaf(leaf.id)}>
      <TileLeafHeader leaf={leaf} isTopLeft={isTopLeft} ctx={ctx} />
      <div ref={setNodeRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {leaf.tabs.map((tab) => (
          <div key={tab.id} className={cn('absolute inset-0', tab.id === leaf.activeTabId ? 'flex' : 'hidden')}>
            {tab.kind === 'agents'
              ? ctx.renderers.agents({ leafId: leaf.id })
              : tab.kind === 'worktree'
                ? ctx.renderers.worktree({ leafId: leaf.id, tab })
                : ctx.renderers.browser({ leafId: leaf.id, tab })}
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
  resolveBrowserTab,
  showContent = true,
  className,
}: WorkspaceTileCanvasProps) {
  const [dragTab, setDragTab] = useState<TileTab | null>(null)
  const [hoverZone, setHoverZone] = useState<{ leafId: string; zone: TileDropZone } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const topLeftLeafId = useMemo(() => firstLeafId(root) ?? root.id, [root])
  const topLeftLeaf = useMemo(() => {
    const found = findTileLeaf(root, topLeftLeafId)
    return found?.type === 'leaf' ? found : null
  }, [root, topLeftLeafId])
  // Only meaningful once a split exists (root.type === 'split' implies >= 2
  // leaves per tileTree.ts's collapse invariant) — a single unsplit leaf
  // shows no title, matching today's clean single-pane look.
  const workspaceTitle = useMemo(() => {
    if (root.type !== 'split') return null
    const titles = collectLeaves(root)
      .map((leaf) => leafShortTitle(leaf, resolveWorktreeTab, resolveBrowserTab))
      .filter(Boolean)
    return titles.length > 1 ? `Workspace (${titles.join(' + ')})` : null
  }, [root, resolveWorktreeTab, resolveBrowserTab])

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
    workspaceTitle,
    renderers,
    onFocusLeaf,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onResizeSplit: handleResizeSplit,
    resolveWorktreeTab,
    resolveBrowserTab,
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
        {showContent ? (
          <TileNodeView node={root} ctx={ctx} />
        ) : topLeftLeaf ? (
          <TileLeafHeader leaf={topLeftLeaf} isTopLeft ctx={ctx} />
        ) : null}
      </div>
      <DragOverlay>
        {dragTab ? (
          <div className="flex h-8 max-w-[200px] items-center gap-1.5 rounded border border-loom-border bg-loom-terminal px-3 font-mono text-[11px] text-loom-fg shadow-[0_10px_28px_rgba(0,0,0,0.5)]">
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} />
            ) : dragTab.kind === 'worktree' ? (
              <StatusDot color={resolveWorktreeTab(dragTab)?.color ?? '#6b7280'} />
            ) : (
              <Globe size={12} />
            )}
            <span className="truncate">
              {dragTab.kind === 'agents'
                ? 'Agents'
                : dragTab.kind === 'worktree'
                  ? (resolveWorktreeTab(dragTab)?.label ?? dragTab.wtId)
                  : (resolveBrowserTab(dragTab)?.label ?? 'Browser')}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
