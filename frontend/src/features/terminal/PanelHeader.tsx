import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { Popover } from '@base-ui/react/popover'
import { MoreHorizontal, PanelBottom, PanelRight, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One tab rendered in a pane's header. Deliberately a local, minimal mirror
 * of the (not-yet-existing) `PaneContent` shape from
 * `docs/superpowers/specs/2026-07-09-terminal-workspace-tiling-design.md` —
 * this component must stay generic and never import from `paneTypes.ts`.
 * `icon` is supplied by the caller (e.g. `TerminalSquare`/`GitBranch`/
 * `MaterialFileIcon`) so PanelHeader never has to know which content kind
 * a tab represents.
 */
export interface PanelHeaderTab {
  id: string
  label: string
  icon?: ReactNode
  dirty?: boolean
}

export interface PanelHeaderProps {
  /** Opaque id of the pane this header belongs to — threaded into drag data as `sourcePaneId`, otherwise unused. */
  paneId: string
  tabs: PanelHeaderTab[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onSplitRight: () => void
  onSplitDown: () => void
  /** Closes this whole pane (all its tabs), distinct from closing a single tab. */
  onClose: () => void
  /** Gates the "..." overflow menu, matching the spec's "rendered only when isFocused" rule. Defaults to true. */
  isFocused?: boolean
  /** Extra chrome rendered after the tab strip (e.g. worktree status/branch/cost) — composed by the caller, never computed here. */
  titleContent?: ReactNode
  /** Arbitrary actions (Details/Delete/Approve, ...) rendered inside the "..." popover. Omit to hide the overflow button entirely. */
  overflowActions?: ReactNode
  /** Actions (New Terminal / Open File...) rendered inside the "+" new-tab popover, right next
   *  to the tab strip — the `Ctrl/Cmd+T` shortcut triggers the same underlying handler on
   *  whichever pane is focused. Omit to hide the "+" button entirely. Unlike `overflowActions`,
   *  not gated by `isFocused` — adding a tab to a specific pane makes sense regardless of which
   *  pane currently owns the "..." menu. */
  newTabActions?: ReactNode
  className?: string
}

const iconButtonClass =
  'flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg'

/** Compact per-pane header: tab strip + split/overflow/close controls. Purely presentational — knows nothing about Terminal/GitPanel/FileEditor. */
export function PanelHeader({
  paneId,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onClose,
  isFocused = true,
  titleContent,
  overflowActions,
  newTabActions,
  className,
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'flex h-8 flex-none items-stretch border-b border-devdeck-border bg-devdeck-surface-2',
        className,
      )}
    >
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <PanelHeaderTabButton
            key={tab.id}
            paneId={paneId}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => onSelectTab(tab.id)}
            onCloseTab={() => onCloseTab(tab.id)}
          />
        ))}
        {newTabActions ? (
          <Popover.Root>
            <Popover.Trigger
              className={cn(iconButtonClass, 'my-1 ml-1 flex-none self-center')}
              title="New tab (Ctrl+T)"
              aria-label="New tab"
            >
              <Plus size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
                <Popover.Popup
                  className={cn(
                    'min-w-[150px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                    'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                    'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                    'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                  )}
                >
                  {newTabActions}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
      </div>

      {titleContent}

      <div className="ml-auto flex flex-none items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={onSplitRight}
          title="Split right"
          aria-label="Split right"
          className={iconButtonClass}
        >
          <PanelRight size={13} />
        </button>
        <button
          type="button"
          onClick={onSplitDown}
          title="Split down"
          aria-label="Split down"
          className={iconButtonClass}
        >
          <PanelBottom size={13} />
        </button>

        {isFocused && overflowActions ? (
          <Popover.Root>
            <Popover.Trigger
              className={iconButtonClass}
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="end" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
                <Popover.Popup
                  className={cn(
                    'min-w-[150px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                    'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                    'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                    'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                  )}
                >
                  {overflowActions}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          title="Close pane"
          aria-label="Close pane"
          className={iconButtonClass}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

function PanelHeaderTabButton({
  paneId,
  tab,
  active,
  onSelect,
  onCloseTab,
}: {
  paneId: string
  tab: PanelHeaderTab
  active: boolean
  onSelect: () => void
  onCloseTab: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { contentId: tab.id, sourcePaneId: paneId },
  })

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onMouseDown={(e) => {
        // Middle-click closes the tab, matching browser/IDE tab-strip convention — a much
        // bigger target than the small per-tab "x", and doesn't require precise aim.
        if (e.button === 1) {
          e.preventDefault()
          onCloseTab()
        }
      }}
      className={cn(
        'group flex h-full max-w-[200px] flex-none touch-none cursor-grab items-center gap-1.5 border-r border-devdeck-border pl-3 pr-1 font-mono text-[11px] active:cursor-grabbing',
        active
          ? 'bg-devdeck-terminal text-devdeck-fg'
          : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
        isDragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={tab.label}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 active:cursor-grabbing"
      >
        {tab.icon}
        <span className="truncate">{tab.label}</span>
        {tab.dirty ? <span className="text-devdeck-yellow">*</span> : null}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onCloseTab()
        }}
        aria-label={`Close ${tab.label}`}
        className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim opacity-60 hover:bg-devdeck-hover-wash hover:text-devdeck-fg group-hover:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  )
}
