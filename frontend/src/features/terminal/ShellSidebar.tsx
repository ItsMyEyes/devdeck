import { useCallback, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Files, GitBranch, MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import type { ShellSidebarPanel } from '@/store/useDevDeckStore'
import { SHELL_SIDEBAR_MAX_WIDTH, SHELL_SIDEBAR_MIN_WIDTH, shellSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'
import { SessionsPanel } from '@/features/agent-chat/SessionsPanel'
import type { FilesTarget } from './filesTarget'
import type { GitDiffTarget } from './paneTree'
import { GitPanel } from './GitPanel'
import { TerminalExplorer } from './TerminalExplorer'

/** Width the drag strip's dblclick restores — mirrors the store's own
 *  unseen-key default (see useDevDeckStore's DEFAULT_SHELL_SIDEBAR). */
const DEFAULT_WIDTH = 280
/** Pixels nudged per arrow-key press on the drag strip. setShellSidebarWidth
 *  clamps the written value to [200, 560] regardless, so this only picks the step size. */
const RESIZE_STEP = 16

export interface ShellSidebarProps {
  /** `wt:<worktreeId>` | `ssh:<connectionId>` — keys this sidebar's open/panel/width in the store. */
  shellKey: string
  target: FilesTarget
  rootLabel: string
  /** Omitted for SSH shells — there is no remote git support to expose, so the
   *  header shows a single Explorer entry rather than a disabled Git button. */
  git?: { worktreeId: string; machine: Machine }
  /** Opens one file's (or commit's) diff as its own pane tab. Called when a
   *  row is picked in the sidebar's list-only GitPanel, which has no diff
   *  column — mirrors how picking a file in Explorer opens an editor tab. */
  onOpenGitDiff?: (target: GitDiffTarget) => void
  /** The threadKey of the chat pane currently open for this worktree, if
   *  any — highlights the matching row in the Sessions tab. */
  activeThreadKey?: string
  /** Opens a session's thread in a chat pane when its row is picked in the
   *  Sessions tab. Optional: `ExpandedTerminal.tsx` (pane management) isn't
   *  in Task 8's file list, so nothing calls this yet — see
   *  `SessionsPanel.tsx`'s doc comment and this task's `deviationsFromPlan`. */
  onOpenThread?: (threadKey: string) => void
  onOpenFile: (path: string) => void
  onFileDeleted: (paths: string[]) => void
  onRequestQuickOpen: () => void
  onRequestContentSearch: () => void
  contentSearchShortcut?: string
}

/**
 * Per-shell sidebar (spec §1): an Explorer/Git switcher header, the active
 * panel's body, and a 4px drag strip to resize. Open state, selected panel,
 * and width all live in the store (`shellSidebars`, keyed by `shellKey`) —
 * this component holds no state of its own beyond the in-flight drag.
 *
 * The panel switcher is a header row rather than a second vertical icon rail:
 * the app already renders its own 56px rail immediately to the left, and two
 * adjacent rails read as one stacked, ambiguous column.
 *
 * Closing hides rather than unmounts: the whole component renders with
 * `display: none` when closed instead of being torn down, so
 * TerminalExplorer's expanded-path set and scroll position survive a
 * toggle — the same reason backgrounded tile tabs are hidden, not unmounted.
 * See docs/superpowers/specs/2026-08-04-sidebar-shell-explorer-design.md §1.
 */
export function ShellSidebar({
  shellKey,
  target,
  rootLabel,
  git,
  onOpenGitDiff,
  activeThreadKey,
  onOpenThread,
  onOpenFile,
  onFileDeleted,
  onRequestQuickOpen,
  onRequestContentSearch,
  contentSearchShortcut,
}: ShellSidebarProps) {
  const shellSidebars = useDevDeckStore((s) => s.shellSidebars)
  const setShellSidebarPanel = useDevDeckStore((s) => s.setShellSidebarPanel)
  const setShellSidebarWidth = useDevDeckStore((s) => s.setShellSidebarWidth)

  const { open, panel, width } = shellSidebarState(shellSidebars, shellKey)
  // A shell with no git support can still carry a stale 'git'/'sessions'
  // panel value (persisted from before, or hand-edited) — fall back to
  // explorer rather than mounting a GitPanel/SessionsPanel with no
  // worktree/machine to give it. Sessions is gated on `git` the same way
  // Git is: both need the worktree/machine pair an SSH shell doesn't have.
  const effectivePanel: ShellSidebarPanel = (panel === 'git' || panel === 'sessions') && git ? panel : 'explorer'

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { startX: event.clientX, startWidth: width }
    },
    [width],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      setShellSidebarWidth(shellKey, drag.startWidth + (event.clientX - drag.startX))
    },
    [shellKey, setShellSidebarWidth],
  )

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleDoubleClick = useCallback(() => {
    setShellSidebarWidth(shellKey, DEFAULT_WIDTH)
  }, [shellKey, setShellSidebarWidth])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setShellSidebarWidth(shellKey, width - RESIZE_STEP)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setShellSidebarWidth(shellKey, width + RESIZE_STEP)
      }
    },
    [shellKey, width, setShellSidebarWidth],
  )

  return (
    <div className="flex min-h-0 flex-none" style={open ? undefined : { display: 'none' }}>
      <div className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden bg-devdeck-card-wash" style={{ width }}>
        {/* Only worth a switcher when there is something to switch between —
            an SSH shell has Explorer alone, so its header would be dead chrome. */}
        {git ? (
          <div className="flex h-8 flex-none items-center gap-1 border-b border-devdeck-border bg-devdeck-pane px-1.5">
            <PanelButton
              label="Explorer"
              icon={<Files size={13} />}
              active={effectivePanel === 'explorer'}
              onClick={() => setShellSidebarPanel(shellKey, 'explorer')}
            />
            <PanelButton
              label="Git"
              icon={<GitBranch size={13} />}
              active={effectivePanel === 'git'}
              onClick={() => setShellSidebarPanel(shellKey, 'git')}
            />
            <PanelButton
              label="Sessions"
              icon={<MessagesSquare size={13} />}
              active={effectivePanel === 'sessions'}
              onClick={() => setShellSidebarPanel(shellKey, 'sessions')}
            />
          </div>
        ) : null}

        <div className={cn('min-h-0 min-w-0 flex-1 flex-col', effectivePanel === 'explorer' ? 'flex' : 'hidden')}>
          <TerminalExplorer
            shellKey={shellKey}
            target={target}
            rootLabel={rootLabel}
            onOpenFile={onOpenFile}
            onFileDeleted={onFileDeleted}
            onRequestQuickOpen={onRequestQuickOpen}
            onRequestContentSearch={onRequestContentSearch}
            contentSearchShortcut={contentSearchShortcut}
          />
        </div>
        {git ? (
          <div className={cn('min-h-0 min-w-0 flex-1', effectivePanel === 'git' ? 'flex' : 'hidden')}>
            <GitPanel
              worktreeId={git.worktreeId}
              machine={git.machine}
              active={open && effectivePanel === 'git'}
              shellKey={shellKey}
              compact
              onOpenDiff={onOpenGitDiff}
            />
          </div>
        ) : null}
        {git ? (
          <div className={cn('min-h-0 min-w-0 flex-1 flex-col', effectivePanel === 'sessions' ? 'flex' : 'hidden')}>
            <SessionsPanel
              worktreeId={git.worktreeId}
              machine={git.machine}
              activeThreadKey={activeThreadKey}
              onSelectThread={onOpenThread}
            />
          </div>
        ) : null}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={SHELL_SIDEBAR_MIN_WIDTH}
        aria-valuemax={SHELL_SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        className="w-1 flex-none cursor-col-resize touch-none bg-devdeck-border transition-colors hover:bg-devdeck-line active:bg-devdeck-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}

function PanelButton({ label, icon, active, onClick }: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-6 flex-none cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-devdeck-on text-devdeck-fg'
          : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
