import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { MoreHorizontal, PanelBottom, PanelRight, Plus, X } from 'lucide-react'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
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
  /** Rendered flush-left, before the tab strip — e.g. the shell sidebar toggle. Omit to render nothing. */
  leadingContent?: ReactNode
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
  'flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg'

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
  leadingContent,
  titleContent,
  overflowActions,
  newTabActions,
  className,
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'flex h-8 flex-none items-stretch border-b border-devdeck-border bg-devdeck-card-wash',
        className,
      )}
    >
      {leadingContent}
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
          <TabStripPopoverMenu
            trigger={<Plus size={13} />}
            triggerClassName={cn(iconButtonClass, 'my-1 ml-1 flex-none self-center')}
            triggerTitle="New tab (Ctrl+T)"
            triggerAriaLabel="New tab"
          >
            {newTabActions}
          </TabStripPopoverMenu>
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
          <TabStripPopoverMenu
            trigger={<MoreHorizontal size={13} />}
            triggerClassName={iconButtonClass}
            triggerTitle="More actions"
            triggerAriaLabel="More actions"
            align="end"
          >
            {overflowActions}
          </TabStripPopoverMenu>
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
          ? 'bg-devdeck-pane text-devdeck-fg'
          : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
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
        className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 opacity-60 hover:bg-devdeck-hover-wash hover:text-devdeck-fg group-hover:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  )
}
