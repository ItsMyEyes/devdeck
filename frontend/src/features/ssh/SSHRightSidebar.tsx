import { useCallback, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Activity, Bot, Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SSHRightSidebarPanel } from '@/store/useDevDeckStore'
import { SSH_RIGHT_SIDEBAR_MAX_WIDTH, SSH_RIGHT_SIDEBAR_MIN_WIDTH, sshRightSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'
import { StatsPane } from '@/features/stats/StatsPane'
import { SSHAgentChatPanel } from './SSHAgentChatPanel'
import { SSHForwardsPanel } from './SSHForwardsPanel'

/** Width the drag strip's dblclick restores — mirrors the store's own
 *  unseen-key default (see useDevDeckStore's DEFAULT_SSH_RIGHT_SIDEBAR). */
const DEFAULT_WIDTH = 300
/** Pixels nudged per arrow-key press on the drag strip. setSSHRightSidebarWidth
 *  clamps the written value to [240, 480] regardless, so this only picks the step size. */
const RESIZE_STEP = 16

/**
 * The SSH pane's right sidebar (Task 8, +Task 12's DevOps Chat): an
 * always-visible icon rail (DevOps Chat + Stats + Port Forwarding) docked at
 * the pane's right edge, mirroring ShellSidebar's left-side Explorer/Git
 * switcher. Unlike ShellSidebar, the rail here IS the switcher — a
 * right-docked panel with its own header row would put the switcher on the
 * wrong edge, so each icon both opens/closes the sidebar and picks which
 * panel it shows.
 *
 * Open state, selected panel, and width all live in the store
 * (`sshRightSidebars`, keyed by `shellKey`) — this component holds no state
 * of its own beyond the in-flight drag.
 *
 * The panel section hides rather than unmounts: it renders with
 * `display: none` when closed instead of being torn down, so StatsPane's
 * internal state/subscriptions, SSHForwardsPanel's scroll position, and the
 * DevOps chat pane's WebSocket + transcript position all survive a toggle —
 * same reasoning as ShellSidebar's own doc comment.
 */
export function SSHRightSidebar({ shellKey, connectionId }: { shellKey: string; connectionId: string }) {
  const sshRightSidebars = useDevDeckStore((s) => s.sshRightSidebars)
  const setSSHRightSidebarOpen = useDevDeckStore((s) => s.setSSHRightSidebarOpen)
  const setSSHRightSidebarPanel = useDevDeckStore((s) => s.setSSHRightSidebarPanel)
  const setSSHRightSidebarWidth = useDevDeckStore((s) => s.setSSHRightSidebarWidth)

  const { open, panel, width } = sshRightSidebarState(sshRightSidebars, shellKey)

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
      // This strip sits on the panel's LEADING (left) edge — the panel's
      // trailing edge is pinned against the always-visible rail — so
      // dragging left (negative clientX delta) grows the panel, the mirror
      // image of ShellSidebar's own trailing-edge strip.
      setSSHRightSidebarWidth(shellKey, drag.startWidth - (event.clientX - drag.startX))
    },
    [shellKey, setSSHRightSidebarWidth],
  )

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleDoubleClick = useCallback(() => {
    setSSHRightSidebarWidth(shellKey, DEFAULT_WIDTH)
  }, [shellKey, setSSHRightSidebarWidth])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Mirrored from ShellSidebar's ArrowLeft/ArrowRight mapping to match
      // this strip's mirrored drag direction above.
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSSHRightSidebarWidth(shellKey, width + RESIZE_STEP)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSSHRightSidebarWidth(shellKey, width - RESIZE_STEP)
      }
    },
    [shellKey, width, setSSHRightSidebarWidth],
  )

  const handleIconClick = useCallback(
    (clicked: SSHRightSidebarPanel) => {
      if (!open) {
        setSSHRightSidebarOpen(shellKey, true)
        setSSHRightSidebarPanel(shellKey, clicked)
        return
      }
      if (panel === clicked) {
        setSSHRightSidebarOpen(shellKey, false)
        return
      }
      setSSHRightSidebarPanel(shellKey, clicked)
    },
    [shellKey, open, panel, setSSHRightSidebarOpen, setSSHRightSidebarPanel],
  )

  return (
    <div className="flex min-h-0 flex-none">
      <div className="flex min-h-0 flex-none" style={open ? undefined : { display: 'none' }}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SSH_RIGHT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={SSH_RIGHT_SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          className="w-1 flex-none cursor-col-resize touch-none bg-devdeck-border transition-colors hover:bg-devdeck-line active:bg-devdeck-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        />
        <div className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden bg-devdeck-card-wash" style={{ width }}>
          {/* All three panels stay mounted (hidden, not torn down) so
           *  switching away from Stats/Port Forwarding/DevOps Chat and back
           *  doesn't wipe StatsPane's component-local sparkline history, lose
           *  SSHForwardsPanel's scroll position, or drop the chat pane's
           *  WebSocket and its place in the transcript — the same
           *  hide-not-unmount reasoning ShellSidebar already applies to
           *  Explorer/Git. `visible` drives each panel's own polling pause
           *  independently (the chat pane has no poll to pause — its socket
           *  stays open regardless, by design). */}
          <div
            data-testid="ssh-chat-panel"
            className={cn('min-h-0 min-w-0 flex-1 flex-col', panel === 'chat' ? 'flex' : 'hidden')}
          >
            <SSHAgentChatPanel connectionId={connectionId} visible={open && panel === 'chat'} />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-1 flex-col', panel === 'forwards' ? 'flex' : 'hidden')}>
            <SSHForwardsPanel connectionId={connectionId} visible={open && panel === 'forwards'} />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-1 flex-col', panel === 'stats' ? 'flex' : 'hidden')}>
            <StatsPane target={{ kind: 'ssh', connectionId }} visible={open && panel === 'stats'} />
          </div>
        </div>
      </div>

      <div className="flex w-9 flex-none flex-col items-center gap-1 border-l border-devdeck-border bg-devdeck-pane py-1.5">
        <RailButton
          label="DevOps Chat"
          icon={<Bot size={15} />}
          active={open && panel === 'chat'}
          onClick={() => handleIconClick('chat')}
        />
        <RailButton
          label="Stats"
          icon={<Activity size={15} />}
          active={open && panel === 'stats'}
          onClick={() => handleIconClick('stats')}
        />
        <RailButton
          label="Port Forwarding"
          icon={<Waypoints size={15} />}
          active={open && panel === 'forwards'}
          onClick={() => handleIconClick('forwards')}
        />
      </div>
    </div>
  )
}

function RailButton({ label, icon, active, onClick }: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
      )}
    >
      {icon}
    </button>
  )
}
