import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { Cable, ChevronLeft, ChevronRight, Globe, LayoutGrid, Plus, X } from 'lucide-react'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { cn } from '@/lib/utils'
import type { WorktreeTabLabel } from '@/lib/worktreeLabel'
import { useDevDeckStore } from '@/store/useDevDeckStore'
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
export type SSHShellTileTab = Extract<TileTab, { kind: 'ssh-shell' }>

export interface WorkspaceTileCanvasProps {
  root: TileNode
  /** Leaf whose tabs own the keyboard — its active tab lights its dot green,
   *  every other leaf's active tab keeps a dimmed one. Without it a split
   *  shows two identically-lit tabs and neither says "you're typing here". */
  focusedLeafId: string
  renderers: {
    agents: (ctx: { leafId: string }) => ReactNode
    worktree: (ctx: { leafId: string; tab: WorktreeTileTab }) => ReactNode
    browser: (ctx: { leafId: string; tab: BrowserTileTab }) => ReactNode
    sshShell: (ctx: { leafId: string; tab: SSHShellTileTab }) => ReactNode
  }
  /** Fired for every structural change this component makes itself: drag-and-drop commits and divider-resize commits. */
  onTreeChange: (root: TileNode) => void
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  /** Live label parts for a worktree tab, resolved by the caller from
   *  react-query data (not stored statically, since a worktree's branch — and
   *  its project's machine — can change while its tab stays open).
   *  `undefined` hides the tab (e.g. a worktree deleted right before pruning
   *  catches up). */
  resolveWorktreeTab: (tab: WorktreeTileTab) => WorktreeTabLabel | undefined
  /** Live title for a browser tab, resolved from the store's `browserTiles`
   *  slice (not stored in the tile tree itself). `undefined` hides the tab
   *  (mirrors `resolveWorktreeTab`'s contract). */
  resolveBrowserTab: (tab: BrowserTileTab) => { label: string } | undefined
  /** Live title for an ssh-shell tab, resolved from the SSH connections
   *  query (mirrors `resolveBrowserTab`'s contract). */
  resolveSSHShellTab: (tab: SSHShellTileTab) => { label: string } | undefined
  /** When `false`, only the top-left leaf's pinned header renders — no
   *  leaf bodies, no other leaves. Used on non-tiled workspace routes
   *  (Machines, Tools, Invoices, ...) so the tab strip stays up as
   *  persistent chrome while `<Outlet/>` takes over the content area
   *  below it. Defaults to `true` (render the full tree, as before). */
  showContent?: boolean
  className?: string
}

interface ChromeRect {
  left: number
  width: number
}

interface TileRenderContext {
  topLeftLeafId: string
  focusedLeafId: string
  topChromeLeafIds: Set<string>
  chromeRects: Record<string, ChromeRect>
  registerLeafElement: (leafId: string, element: HTMLDivElement | null) => void
  renderers: WorkspaceTileCanvasProps['renderers']
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  resolveSSHShellTab: WorkspaceTileCanvasProps['resolveSSHShellTab']
  hoverZone: { leafId: string; zone: TileDropZone } | null
}

function collectTopChromeLeafIds(node: TileNode): string[] {
  if (node.type === 'leaf') return [node.id]
  if (node.children.length === 0) return []
  if (node.direction === 'column') return collectTopChromeLeafIds(node.children[0])
  return node.children.flatMap(collectTopChromeLeafIds)
}

function sameChromeRects(a: Record<string, ChromeRect>, b: Record<string, ChromeRect>) {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key]?.left === b[key]?.left && a[key]?.width === b[key]?.width)
}

/** Leading dot on every tab pill: green on the active tab of the focused
 *  leaf, a dimmed green on the active tab of any other leaf (its content is
 *  visible but it doesn't own the keyboard), inert grey otherwise. Worktree
 *  tabs deliberately no longer show their agent's run-state colour here — one
 *  dot per pill, and it answers "which tab am I looking at". */
function TabDot({ active, focused }: { active: boolean; focused: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 flex-none rounded-full transition-[background-color,box-shadow] duration-150',
        active
          ? focused
            ? 'bg-devdeck-green shadow-[0_0_0_2px_rgba(86,213,138,0.14),0_0_7px_rgba(86,213,138,0.22)]'
            : 'bg-devdeck-green/40'
          : 'bg-devdeck-dim-3',
      )}
    />
  )
}

function primaryShortcutLabel(index: number): string {
  const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  return isApple ? `⌘${index}` : `Ctrl+${index}`
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
  const setTileDragActive = useDevDeckStore((s) => s.setTileDragActive)

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
    setTileDragActive(false)
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
                'flex-none touch-none bg-devdeck-border transition-colors hover:bg-devdeck-accent active:bg-devdeck-accent',
                isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
              )}
              onPointerDown={(event) => {
                const container = containerRef.current
                if (!container) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                setTileDragActive(true)
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
              onPointerCancel={handlePointerUp}
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
  focused,
  compact,
  shortcutNumber,
  resolveWorktreeTab,
  resolveBrowserTab,
  resolveSSHShellTab,
  onSelect,
  onClose,
}: {
  leafId: string
  tab: TileTab
  active: boolean
  /** Whether this tab's own leaf is the focused one — only affects how bright
   *  an *active* tab's dot burns (see `TabDot`). */
  focused: boolean
  /** Non-top-left leaves render a visually lighter strip so a split never
   *  reads as "two full tab strips stacked" — see TileLeafView. */
  compact: boolean
  /** 1-based Cmd/Ctrl shortcut for the first four tabs in this leaf. */
  shortcutNumber?: number
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  resolveSSHShellTab: WorkspaceTileCanvasProps['resolveSSHShellTab']
  onSelect: () => void
  onClose?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { tabId: tab.id, sourceLeafId: leafId },
  })

  // Numeric shortcuts are scoped to the focused leaf, so only advertise
  // them on the strip they currently control.
  const shortcut = shortcutNumber && focused ? primaryShortcutLabel(shortcutNumber) : null
  const selectButtonClass =
    'flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60'

  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex flex-none touch-none cursor-grab items-center gap-1.5 rounded-[9px] border font-mono',
      'transition-[background-color,border-color,color,box-shadow,opacity] duration-150 active:cursor-grabbing',
      // Wider than the old label-only pills: a worktree tab now carries a
      // "<project>/<machine> · " origin prefix ahead of its session name.
      compact
        ? 'h-6 max-w-[200px] rounded-[7px] pl-2 pr-1 text-[11px]'
        : 'h-8 max-w-[270px] pl-2.5 pr-1.5 text-[11.5px]',
      active && focused
        ? 'border-devdeck-border-strong bg-devdeck-elevated text-devdeck-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_1px_3px_rgba(0,0,0,0.24)]'
        : active
          ? 'border-devdeck-border-card bg-devdeck-surface-2 text-devdeck-fg-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]'
          : 'border-transparent bg-transparent text-devdeck-muted hover:border-devdeck-border-card hover:bg-devdeck-surface-2 hover:text-devdeck-fg-2',
      dragging && 'opacity-40',
    )

  const titleWithShortcut = (title: string) => (shortcut ? `${title} — ${shortcut}` : title)

  const closeButton = (label: string, className?: string) =>
    onClose ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${label}`}
        className={cn(
          'pointer-events-none flex-none rounded p-0.5 text-devdeck-dim opacity-0 transition-[background-color,color,opacity]',
          'hover:bg-devdeck-hover-wash-menu hover:text-devdeck-fg group-hover:pointer-events-auto group-hover:opacity-100',
          'focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
          className,
        )}
      >
        <X size={11} />
      </button>
    ) : null

  const trailingAction = (label: string) => {
    if (compact || !shortcut) return closeButton(label)
    if (!onClose) {
      return (
        <kbd
          aria-label={`Shortcut ${shortcut}`}
          className={cn(
            'flex h-[17px] flex-none items-center rounded-[5px] border border-devdeck-border-card bg-devdeck-surface px-1',
            'font-mono text-[8.5px] leading-none text-devdeck-dim transition-opacity',
            active ? 'opacity-75' : 'opacity-35 group-hover:opacity-65',
          )}
        >
          {shortcut}
        </kbd>
      )
    }
    return (
      <span className="relative flex h-[18px] min-w-[36px] flex-none items-center justify-end">
        <kbd
          aria-label={`Shortcut ${shortcut}`}
          className={cn(
            'flex h-[17px] items-center rounded-[5px] border border-devdeck-border-card bg-devdeck-surface px-1',
            'font-mono text-[8.5px] leading-none text-devdeck-dim transition-opacity group-hover:opacity-0 group-focus-within:opacity-0',
            active ? 'opacity-75' : 'opacity-35',
          )}
        >
          {shortcut}
        </kbd>
        {closeButton(label, 'absolute right-0')}
      </span>
    )
  }

  if (tab.kind === 'worktree') {
    const info = resolveWorktreeTab(tab)
    if (!info) return null
    return (
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        data-tab-id={tab.id}
        title={titleWithShortcut(info.title)}
        className={wrapperClass(isDragging)}
      >
        <button type="button" onClick={onSelect} className={selectButtonClass}>
          <TabDot active={active} focused={focused} />
          {/* The origin prefix carries almost all of the shrink (`shrink-[0.02]`
              on the name only lets it give way once the prefix is gone), so a
              cramped pill degrades to "devd… · shell 3" — never to a row of
              identical "devdeck/kal…" stubs with the session name cut off. */}
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 shrink truncate text-devdeck-dim">{info.prefix}</span>
            <span className="flex-none text-devdeck-dim-3">·</span>
            <span className="min-w-0 shrink-[0.02] truncate">{info.name}</span>
          </span>
        </button>
        {trailingAction(info.name)}
      </div>
    )
  }

  if (tab.kind === 'ssh-shell') {
    const info = resolveSSHShellTab(tab)
    if (!info) return null
    return (
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        data-tab-id={tab.id}
        title={titleWithShortcut(info.label)}
        className={wrapperClass(isDragging)}
      >
        <button type="button" onClick={onSelect} className={selectButtonClass}>
          <TabDot active={active} focused={focused} />
          <Cable size={12} className="flex-none" />
          <span className="truncate">{info.label}</span>
        </button>
        {trailingAction(info.label)}
      </div>
    )
  }

  if (tab.kind === 'browser') {
    const info = resolveBrowserTab(tab)
    if (!info) return null
    return (
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        data-tab-id={tab.id}
        title={titleWithShortcut(info.label)}
        className={wrapperClass(isDragging)}
      >
        <button type="button" onClick={onSelect} className={selectButtonClass}>
          <TabDot active={active} focused={focused} />
          <Globe size={12} className="flex-none" />
          <span className="truncate">{info.label}</span>
        </button>
        {trailingAction(info.label)}
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-tab-id={tab.id}
      title={titleWithShortcut('Agents')}
      className={wrapperClass(isDragging)}
    >
      <button type="button" onClick={onSelect} className={selectButtonClass}>
        <TabDot active={active} focused={focused} />
        <LayoutGrid size={12} className="flex-none" />
        <span className="truncate">Agents</span>
      </button>
      {trailingAction('Agents')}
    </div>
  )
}

function ScrollableTabStrip({
  activeTabId,
  itemsKey,
  children,
}: {
  activeTabId: string
  itemsKey: string
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const container = containerRef.current
    const scroller = scrollerRef.current
    if (!container || !scroller) return

    const nextOverflowing = scroller.scrollWidth > container.clientWidth + 1
    const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    setOverflowing(nextOverflowing)
    setCanScrollLeft(nextOverflowing && scroller.scrollLeft > 1)
    setCanScrollRight(nextOverflowing && scroller.scrollLeft < maxScrollLeft - 1)
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    const scroller = scrollerRef.current
    if (!container || !scroller) return

    updateScrollState()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState)
    observer?.observe(container)
    observer?.observe(scroller)

    return () => observer?.disconnect()
  }, [itemsKey, updateScrollState])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const activeTab = Array.from(scroller.children).find(
      (child) => child instanceof HTMLElement && child.dataset.tabId === activeTabId,
    )
    if (!(activeTab instanceof HTMLElement)) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    activeTab.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, itemsKey, updateScrollState])

  function scroll(direction: -1 | 1) {
    const scroller = scrollerRef.current
    if (!scroller) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.scrollBy({
      left: direction * Math.max(160, scroller.clientWidth * 0.7),
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }

  const scrollButtonClass =
    'flex h-full w-7 flex-none items-center justify-center border-devdeck-border text-devdeck-dim transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-devdeck-dim'

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 self-stretch">
      {overflowing ? (
        <button
          type="button"
          onClick={() => scroll(-1)}
          disabled={!canScrollLeft}
          aria-label="Scroll tabs left"
          title="Scroll tabs left"
          className={cn(scrollButtonClass, 'border-r')}
        >
          <ChevronLeft size={13} />
        </button>
      ) : null}
      <div
        ref={scrollerRef}
        data-tauri-drag-region
        onScroll={updateScrollState}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {overflowing ? (
        <button
          type="button"
          onClick={() => scroll(1)}
          disabled={!canScrollRight}
          aria-label="Scroll tabs right"
          title="Scroll tabs right"
          className={cn(scrollButtonClass, 'border-l')}
        >
          <ChevronRight size={13} />
        </button>
      ) : null}
    </div>
  )
}

/** A leaf's own header row: its tab strip. Extracted from `TileLeafView` so
 *  it can also render standalone (no body, no other leaves) as the
 *  persistent chrome on non-tiled workspace routes — see `showContent` on
 *  `WorkspaceTileCanvas`. */
function TileLeafHeader({
  leaf,
  isTopLeft,
  topChrome,
  focused,
  chromeRect,
  ctx,
}: {
  leaf: TileLeaf
  isTopLeft: boolean
  topChrome: boolean
  /** Passed in rather than derived from `ctx.focusedLeafId`: when this header
   *  renders standalone (`showContent === false`) it is the only strip on
   *  screen, so it reads as focused whatever the tree's stored focus says. */
  focused: boolean
  chromeRect?: ChromeRect
  ctx: TileRenderContext
}) {
  const { setNodeRef: setHeaderDropRef } = useDroppable({
    id: `${leaf.id}::header`,
    data: { leafId: leaf.id, forceCenter: true },
  })
  const headerStyle: CSSProperties | undefined = topChrome
    ? chromeRect
      ? { left: chromeRect.left, width: chromeRect.width }
      : isTopLeft
        ? { left: 0, right: 0 }
        : { visibility: 'hidden' }
    : undefined

  return (
    <div
      ref={setHeaderDropRef}
      style={headerStyle}
      className={cn(
        'flex items-center overflow-hidden border-b border-devdeck-border',
        topChrome
          ? // Every leaf touching the workspace's top edge gets a real chrome
            // strip. The first one starts at the true viewport edge so it
            // still fuses with macOS's overlaid traffic lights; sibling top
            // strips are measured to their split column, filling the blank
            // upper area instead of pushing a second row into the pane body.
            'fixed top-0 z-40 h-10 bg-devdeck-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.018)]'
          : // Lower split panes keep the lighter in-pane header; they don't
            // compete with the app chrome or steal vertical space from top panes.
            'h-8 flex-none bg-devdeck-surface-2',
        topChrome && !isTopLeft && 'border-l border-devdeck-border',
      )}
    >
      {topChrome && isTopLeft ? (
        <div data-tauri-drag-region className="h-full flex-none" style={{ width: TRAFFIC_LIGHT_GUTTER }} />
      ) : null}
      <ScrollableTabStrip activeTabId={leaf.activeTabId} itemsKey={leaf.tabs.map((tab) => tab.id).join('|')}>
        {leaf.tabs.map((tab, i) => (
          <Fragment key={tab.id}>
            <TileTabButton
              leafId={leaf.id}
              tab={tab}
              active={tab.id === leaf.activeTabId}
              focused={focused}
              compact={!topChrome}
              shortcutNumber={i < 4 ? i + 1 : undefined}
              resolveWorktreeTab={ctx.resolveWorktreeTab}
              resolveBrowserTab={ctx.resolveBrowserTab}
              resolveSSHShellTab={ctx.resolveSSHShellTab}
              onSelect={() => ctx.onSelectTab(leaf.id, tab.id)}
              onClose={tab.kind !== 'agents' ? () => ctx.onCloseTab(leaf.id, tab.id) : undefined}
            />
            {/* Divider after the pinned Agents tab, matching the flat TabBar's original look. */}
            {tab.kind === 'agents' && i < leaf.tabs.length - 1 ? (
              <div className="mx-1.5 h-4 w-px flex-none bg-devdeck-border-menu" />
            ) : null}
          </Fragment>
        ))}
      </ScrollableTabStrip>
      <button
        type="button"
        onClick={() => ctx.onNewTab(leaf.id)}
        aria-label="New tab"
        title="New tab"
        className={cn(
          'ml-0.5 mr-1 flex flex-none items-center justify-center rounded-[8px] border border-transparent text-devdeck-dim',
          'transition-[background-color,border-color,color] hover:border-devdeck-border-card hover:bg-devdeck-surface-2 hover:text-devdeck-fg',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
          topChrome ? 'h-7 w-7' : 'h-6 w-6 rounded-[7px]',
        )}
      >
        <Plus size={topChrome ? 13 : 11} />
      </button>
    </div>
  )
}

function TileLeafView({ leaf, ctx }: { leaf: TileLeaf; ctx: TileRenderContext }) {
  const { setNodeRef } = useDroppable({ id: leaf.id, data: { leafId: leaf.id } })
  const hoverZone = ctx.hoverZone && ctx.hoverZone.leafId === leaf.id ? ctx.hoverZone.zone : null
  const isTopLeft = leaf.id === ctx.topLeftLeafId
  const topChrome = ctx.topChromeLeafIds.has(leaf.id)
  const registerLeafElement = ctx.registerLeafElement
  const setLeafRef = useCallback(
    (element: HTMLDivElement | null) => registerLeafElement(leaf.id, element),
    [leaf.id, registerLeafElement],
  )

  return (
    <div ref={setLeafRef} className="flex min-h-0 min-w-0 flex-1 flex-col" onPointerDownCapture={() => ctx.onFocusLeaf(leaf.id)}>
      <TileLeafHeader
        leaf={leaf}
        isTopLeft={isTopLeft}
        topChrome={topChrome}
        focused={leaf.id === ctx.focusedLeafId}
        chromeRect={ctx.chromeRects[leaf.id]}
        ctx={ctx}
      />
      <div ref={setNodeRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {leaf.tabs.map((tab) => (
          <div key={tab.id} className={cn('absolute inset-0', tab.id === leaf.activeTabId ? 'flex' : 'hidden')}>
            {tab.kind === 'agents'
              ? ctx.renderers.agents({ leafId: leaf.id })
              : tab.kind === 'worktree'
                ? ctx.renderers.worktree({ leafId: leaf.id, tab })
                : tab.kind === 'ssh-shell'
                  ? ctx.renderers.sshShell({ leafId: leaf.id, tab })
                  : ctx.renderers.browser({ leafId: leaf.id, tab })}
          </div>
        ))}
        {hoverZone ? (
          <div
            className="pointer-events-none absolute z-10 border-2 border-devdeck-accent bg-devdeck-accent/15"
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
  focusedLeafId,
  renderers,
  onTreeChange,
  onFocusLeaf,
  onSelectTab,
  onCloseTab,
  onNewTab,
  resolveWorktreeTab,
  resolveBrowserTab,
  resolveSSHShellTab,
  showContent = true,
  className,
}: WorkspaceTileCanvasProps) {
  const [dragTab, setDragTab] = useState<TileTab | null>(null)
  // A dragged tab's ghost preview (DragOverlay below) is a DOM portal, and a
  // native Browser-tile webview always paints above the DOM — without this,
  // dragging any tab (including a Browser tab itself) renders its ghost
  // underneath an open Browser tile instead of following the pointer over it.
  useNativeOverlayBlocker(dragTab !== null)
  const [hoverZone, setHoverZone] = useState<{ leafId: string; zone: TileDropZone } | null>(null)
  const [chromeRects, setChromeRects] = useState<Record<string, ChromeRect>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const leafElementsRef = useRef(new Map<string, HTMLDivElement>())

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const topLeftLeafId = useMemo(() => firstLeafId(root) ?? root.id, [root])
  const topChromeLeafIdList = useMemo(() => collectTopChromeLeafIds(root), [root])
  const topChromeLeafIds = useMemo(() => new Set(topChromeLeafIdList), [topChromeLeafIdList])
  const topLeftLeaf = useMemo(() => {
    const found = findTileLeaf(root, topLeftLeafId)
    return found?.type === 'leaf' ? found : null
  }, [root, topLeftLeafId])
  const registerLeafElement = useCallback((leafId: string, element: HTMLDivElement | null) => {
    if (element) leafElementsRef.current.set(leafId, element)
    else leafElementsRef.current.delete(leafId)
  }, [])

  const measureChromeRects = useCallback(() => {
    const viewportWidth = window.innerWidth
    const next: Record<string, ChromeRect> = {}

    for (const leafId of topChromeLeafIdList) {
      const element = leafElementsRef.current.get(leafId)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      const left = leafId === topLeftLeafId ? 0 : Math.max(0, rect.left)
      const right = Math.min(viewportWidth, Math.max(left, rect.right))
      next[leafId] = {
        left: Math.round(left),
        width: Math.max(0, Math.round(right - left)),
      }
    }

    setChromeRects((current) => (sameChromeRects(current, next) ? current : next))
  }, [topChromeLeafIdList, topLeftLeafId])

  useLayoutEffect(() => {
    measureChromeRects()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureChromeRects)
    if (rootRef.current) observer?.observe(rootRef.current)
    for (const leafId of topChromeLeafIdList) {
      const element = leafElementsRef.current.get(leafId)
      if (element) observer?.observe(element)
    }
    window.addEventListener('resize', measureChromeRects)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measureChromeRects)
    }
  }, [measureChromeRects, topChromeLeafIdList])

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
    focusedLeafId,
    topChromeLeafIds,
    chromeRects,
    registerLeafElement,
    renderers,
    onFocusLeaf,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onResizeSplit: handleResizeSplit,
    resolveWorktreeTab,
    resolveBrowserTab,
    resolveSSHShellTab,
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
      <div ref={rootRef} className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
        {showContent ? (
          <TileNodeView node={root} ctx={ctx} />
        ) : topLeftLeaf ? (
          <TileLeafHeader leaf={topLeftLeaf} isTopLeft topChrome focused ctx={ctx} />
        ) : null}
      </div>
      <DragOverlay>
        {dragTab ? (
          <div className="flex h-8 max-w-[240px] items-center gap-1.5 rounded-[9px] border border-devdeck-border-strong bg-devdeck-elevated px-3 font-mono text-[11px] text-devdeck-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_12px_30px_rgba(0,0,0,0.52)]">
            <TabDot active focused />
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} className="flex-none" />
            ) : dragTab.kind === 'ssh-shell' ? (
              <Cable size={12} className="flex-none" />
            ) : dragTab.kind === 'browser' ? (
              <Globe size={12} className="flex-none" />
            ) : null}
            <span className="truncate">
              {dragTab.kind === 'agents'
                ? 'Agents'
                : dragTab.kind === 'worktree'
                  ? (resolveWorktreeTab(dragTab)?.name ?? dragTab.wtId)
                  : dragTab.kind === 'ssh-shell'
                    ? (resolveSSHShellTab(dragTab)?.label ?? 'SSH')
                    : (resolveBrowserTab(dragTab)?.label ?? 'Browser')}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
