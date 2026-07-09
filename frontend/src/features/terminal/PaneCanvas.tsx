import { Fragment, useCallback, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { findContent, moveTab, resizeSplit } from './paneTree'
import type {
  DropZone,
  LeafPane,
  PaneContent,
  PaneContentKind,
  PaneNode,
  SplitDirection,
  SplitPane,
} from './paneTree'
import { PanelHeader } from './PanelHeader'
import type { PanelHeaderTab } from './PanelHeader'

/** A split's children never shrink below this fraction of the split's axis while dragging a divider. */
const MIN_PANE_SIZE = 0.08

export interface PaneContentRenderContext {
  /** The full union — narrow via `content.kind` inside a kind-specific renderer. */
  content: PaneContent
  paneId: string
  isActive: boolean
}

export type PaneContentRenderer = (ctx: PaneContentRenderContext) => ReactNode

export type PaneContentRendererMap = Record<PaneContentKind, PaneContentRenderer>

export interface PaneCanvasProps {
  root: PaneNode
  /** Drives which pane's `PanelHeader` shows its "..." overflow menu. */
  focusedPaneId: string
  /** One render function per `PaneContentKind` — keeps this component agnostic of Terminal/GitPanel/FileEditor specifics. */
  renderers: PaneContentRendererMap
  /** Fired for every structural change this component makes itself: drag-and-drop commits and divider-resize commits. */
  onTreeChange: (root: PaneNode) => void
  onFocusPane: (paneId: string) => void
  onSelectTab: (paneId: string, contentId: string) => void
  onCloseTab: (paneId: string, contentId: string) => void
  onSplitPane: (paneId: string, direction: SplitDirection) => void
  /** Closes the whole pane (all its tabs) — distinct from `onCloseTab`. */
  onClosePane: (paneId: string) => void
  /** Icon shown in a tab's header button, e.g. `TerminalSquare`/`GitBranch`/`MaterialFileIcon`. */
  tabIcon?: (content: PaneContent) => ReactNode
  isTabDirty?: (content: PaneContent) => boolean
  /** Extra chrome appended to a pane's header, e.g. worktree status/branch/cost — caller decides when to show it (per spec, only when the pane's active tab is Terminal content). */
  paneTitleContent?: (pane: LeafPane) => ReactNode
  /** Rendered inside the "..." popover; only ever shown while the pane is focused. Omit to hide the overflow button. */
  paneOverflowActions?: (pane: LeafPane) => ReactNode
  /** Set false below the `md` breakpoint. Disables the DnD sensors entirely, and also
   *  collapses every `SplitPane` to a vertically scroll-snapped stack (one leaf full-bleed
   *  at a time, resize handles hidden) instead of the side-by-side/resizable layout — spec
   *  decision 10, "no room for tiling on a phone-width screen". Defaults to true. */
  dragEnabled?: boolean
  className?: string
}

interface PaneRenderContext {
  focusedPaneId: string
  renderers: PaneContentRendererMap
  onFocusPane: (paneId: string) => void
  onSelectTab: (paneId: string, contentId: string) => void
  onCloseTab: (paneId: string, contentId: string) => void
  onSplitPane: (paneId: string, direction: SplitDirection) => void
  onClosePane: (paneId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  tabIcon?: (content: PaneContent) => ReactNode
  isTabDirty?: (content: PaneContent) => boolean
  paneTitleContent?: (pane: LeafPane) => ReactNode
  paneOverflowActions?: (pane: LeafPane) => ReactNode
  hoverZone: { paneId: string; zone: DropZone } | null
  /** Mirrors `PaneCanvasProps.dragEnabled` — `false` below the `md` breakpoint, where
   *  `SplitPaneView` stacks instead of laying out side by side (spec decision 10). */
  stacked: boolean
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Bucket a drop point (normalized to the target rect) into one of the 5 zones. Ties (a corner
 *  satisfying both an x-edge and a y-edge) go to whichever axis's value is closer to its edge. */
function computeDropZone(dx: number, dy: number): DropZone {
  const xEdge: DropZone | null = dx < 0.25 ? 'left' : dx > 0.75 ? 'right' : null
  const yEdge: DropZone | null = dy < 0.25 ? 'top' : dy > 0.75 ? 'bottom' : null
  if (xEdge && yEdge) {
    return Math.min(dx, 1 - dx) <= Math.min(dy, 1 - dy) ? xEdge : yEdge
  }
  return xEdge ?? yEdge ?? 'center'
}

function resolveHover(event: DragMoveEvent | DragEndEvent): { paneId: string; zone: DropZone } | null {
  const { active, over } = event
  if (!over) return null
  const translated = active.rect.current.translated
  if (!translated || !over.rect.width || !over.rect.height) return null
  const centerX = translated.left + translated.width / 2
  const centerY = translated.top + translated.height / 2
  const dx = clamp01((centerX - over.rect.left) / over.rect.width)
  const dy = clamp01((centerY - over.rect.top) / over.rect.height)
  return { paneId: String(over.id), zone: computeDropZone(dx, dy) }
}

function zoneStyle(zone: DropZone): CSSProperties {
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

/** Recursive dispatcher, defensive per the spec's "Error handling" section: a degenerate
 *  split (<2 children) renders its one remaining child in place, an empty leaf renders nothing. */
function PaneNodeView({ node, ctx }: { node: PaneNode; ctx: PaneRenderContext }) {
  if (node.type === 'leaf') {
    if (node.tabs.length === 0) return null
    return <LeafPaneView pane={node} ctx={ctx} />
  }
  if (node.children.length === 0) return null
  if (node.children.length === 1) return <PaneNodeView node={node.children[0]} ctx={ctx} />
  return <SplitPaneView node={node} ctx={ctx} />
}

function SplitPaneView({ node, ctx }: { node: SplitPane; ctx: PaneRenderContext }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ index: number; startSizes: number[]; startPos: number; containerSize: number } | null>(
    null,
  )
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null)

  const isRow = node.direction === 'row'
  const sizes = liveSizes ?? node.sizes
  const stacked = ctx.stacked

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
    <div
      ref={containerRef}
      className={cn(
        'flex min-h-0 min-w-0 flex-1',
        stacked ? 'flex-col overflow-y-auto snap-y snap-mandatory' : isRow ? 'flex-row' : 'flex-col',
      )}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && !stacked ? (
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
            className={cn('flex min-h-0 min-w-0 overflow-hidden', stacked && 'h-full w-full flex-none snap-start')}
            style={stacked ? undefined : { flexGrow: sizes[i] ?? 1, flexBasis: 0, flexShrink: 1 }}
          >
            <PaneNodeView node={child} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function LeafPaneView({ pane, ctx }: { pane: LeafPane; ctx: PaneRenderContext }) {
  const { setNodeRef } = useDroppable({ id: pane.id, data: { paneId: pane.id } })
  const isFocused = ctx.focusedPaneId === pane.id
  const activeContent = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]

  const tabs: PanelHeaderTab[] = pane.tabs.map((content) => ({
    id: content.id,
    label: content.label,
    icon: ctx.tabIcon?.(content),
    dirty: ctx.isTabDirty?.(content),
  }))

  const hoverZone = ctx.hoverZone && ctx.hoverZone.paneId === pane.id ? ctx.hoverZone.zone : null

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => ctx.onFocusPane(pane.id)}
    >
      <PanelHeader
        paneId={pane.id}
        tabs={tabs}
        activeTabId={pane.activeTabId}
        onSelectTab={(tabId) => ctx.onSelectTab(pane.id, tabId)}
        onCloseTab={(tabId) => ctx.onCloseTab(pane.id, tabId)}
        onSplitRight={() => ctx.onSplitPane(pane.id, 'row')}
        onSplitDown={() => ctx.onSplitPane(pane.id, 'column')}
        onClose={() => ctx.onClosePane(pane.id)}
        isFocused={isFocused}
        titleContent={activeContent?.kind === 'terminal' ? ctx.paneTitleContent?.(pane) : undefined}
        overflowActions={isFocused ? ctx.paneOverflowActions?.(pane) : undefined}
      />
      <div ref={setNodeRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {pane.tabs.map((content) => (
          <div
            key={content.id}
            className={cn('absolute inset-0', content.id === pane.activeTabId ? 'block' : 'hidden')}
          >
            {ctx.renderers[content.kind]({ content, paneId: pane.id, isActive: content.id === pane.activeTabId })}
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

/** Renders a `PaneNode` tree as a resizable tiling canvas and wires up drag-and-drop tab
 *  rearrangement (5-zone edge/center detection, `DragOverlay` preview, live drop-zone highlight).
 *  Every mutation this component makes to the tree — divider resize commits and DnD drops — goes
 *  through `onTreeChange`; everything else (tab select/close, split, pane close, focus) is fully
 *  delegated to the matching callback prop so this component stays agnostic of what a "terminal"
 *  or "file" actually is. */
export function PaneCanvas({
  root,
  focusedPaneId,
  renderers,
  onTreeChange,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onSplitPane,
  onClosePane,
  tabIcon,
  isTabDirty,
  paneTitleContent,
  paneOverflowActions,
  dragEnabled = true,
  className,
}: PaneCanvasProps) {
  const [dragContent, setDragContent] = useState<PaneContent | null>(null)
  const [hoverZone, setHoverZone] = useState<{ paneId: string; zone: DropZone } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleResizeSplit = useCallback(
    (splitId: string, sizes: number[]) => {
      const next = resizeSplit(root, splitId, sizes)
      if (next !== root) onTreeChange(next)
    },
    [root, onTreeChange],
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDragContent(findContent(root, String(event.active.id)) ?? null)
    },
    [root],
  )

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setHoverZone(resolveHover(event))
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragContent(null)
      setHoverZone(null)
      const { active, over } = event
      if (!over) return
      const data = active.data.current as { contentId?: string; sourcePaneId?: string } | undefined
      const sourcePaneId = data?.sourcePaneId
      if (!sourcePaneId) return
      const contentId = data?.contentId ?? String(active.id)
      const resolved = resolveHover(event)
      const zone = resolved?.zone ?? 'center'
      const next = moveTab(root, sourcePaneId, String(over.id), contentId, zone)
      if (next !== root) onTreeChange(next)
    },
    [root, onTreeChange],
  )

  const handleDragCancel = useCallback(() => {
    setDragContent(null)
    setHoverZone(null)
  }, [])

  const ctx: PaneRenderContext = {
    focusedPaneId,
    renderers,
    onFocusPane,
    onSelectTab,
    onCloseTab,
    onSplitPane,
    onClosePane,
    onResizeSplit: handleResizeSplit,
    tabIcon,
    isTabDirty,
    paneTitleContent,
    paneOverflowActions,
    hoverZone,
    stacked: !dragEnabled,
  }

  return (
    <DndContext
      sensors={dragEnabled ? sensors : []}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={cn('flex min-h-0 min-w-0 flex-1', className)}>
        <PaneNodeView node={root} ctx={ctx} />
      </div>
      <DragOverlay>
        {dragContent ? (
          <div className="flex h-8 max-w-[200px] items-center gap-1.5 rounded border border-loom-border bg-loom-terminal px-3 font-mono text-[11px] text-loom-fg shadow-[0_10px_28px_rgba(0,0,0,0.5)]">
            {tabIcon?.(dragContent)}
            <span className="truncate">{dragContent.label}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
