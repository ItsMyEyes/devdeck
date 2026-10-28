import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Activity, Bot, History, Maximize2, Minimize2, Plus, Waypoints, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SSHRightSidebarPanel } from '@/store/useDevDeckStore'
import { SSH_RIGHT_SIDEBAR_MAX_WIDTH, SSH_RIGHT_SIDEBAR_MIN_WIDTH, sshRightSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { nextFreeThreadKey, SessionsPanel } from '@/features/agent-chat/SessionsPanel'
import { StatsPane } from '@/features/stats/StatsPane'
import { tourAnchor, type TourAnchor } from '@/features/tour/tourAnchors'
import { useAgentThreads, useSSHConnections, useMachines } from '@/features/data/queries'
import { HUB_MACHINE, SSHAgentChatPanel } from './SSHAgentChatPanel'
import { SSHForwardsPanel } from './SSHForwardsPanel'

/** Width the drag strip's dblclick restores — mirrors the store's own
 *  unseen-key default (see useDevDeckStore's DEFAULT_SSH_RIGHT_SIDEBAR). */
const DEFAULT_WIDTH = 300
/** Pixels nudged per arrow-key press on the drag strip. */
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

  const state = sshRightSidebarState(sshRightSidebars, shellKey)
  const { open, panel, width, expanded = false } = state
  const setChat = useDevDeckStore((s) => s.setSSHRightSidebarChat)
  const agentThreads = useDevDeckStore((s) => s.agentThreads)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    const parent = sidebarRef.current?.parentElement
    if (!parent) return
    const update = () => setContainerWidth(parent.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const sessionsWorktreeId = `ssh:${connectionId}`
  const connections = useSSHConnections()
  const machines = useMachines()
  const executorId = connections.data?.find((c) => c.id === connectionId)?.executorMachineId
  const executor = machines.data?.find((m) => m.id === executorId)
  const sessions = useAgentThreads(executor, sessionsWorktreeId)
  const fallbackThread = sessions.data?.[0]?.id ?? sessionsWorktreeId
  const tabs = state.chatTabs ?? [fallbackThread]
  const active = tabs.includes(state.activeChatTab ?? '') ? state.activeChatTab! : tabs[0]
  const fullWidth = containerWidth ? Math.max(SSH_RIGHT_SIDEBAR_MIN_WIDTH, containerWidth - 40) : SSH_RIGHT_SIDEBAR_MAX_WIDTH
  const overlayChat = panel === 'chat' && open
  const displayedWidth = expanded && containerWidth ? fullWidth : Math.min(width, fullWidth)

  function selectThread(threadKey: string) {
    setChat(shellKey, { chatTabs: tabs.includes(threadKey) ? tabs : [...tabs, threadKey], activeChatTab: threadKey })
  }
  function closeThread(threadKey: string) {
    const remaining = tabs.filter((key) => key !== threadKey)
    const index = tabs.indexOf(threadKey)
    setChat(shellKey, { chatTabs: remaining, activeChatTab: active === threadKey ? remaining[Math.min(index, remaining.length - 1)] : active })
  }
  function newSession() {
    selectThread(nextFreeThreadKey(sessionsWorktreeId, [...tabs, ...(sessions.data ?? []).map((thread) => thread.id)]))
  }

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { startX: event.clientX, startWidth: displayedWidth }
      if (expanded) setChat(shellKey, { expanded: false })
    },
    [displayedWidth, expanded, setChat, shellKey],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      // This strip sits on the panel's LEADING (left) edge — the panel's
      // trailing edge is pinned against the always-visible rail — so
      // dragging left (negative clientX delta) grows the panel, the mirror
      // image of ShellSidebar's own trailing-edge strip.
      setSSHRightSidebarWidth(shellKey, Math.min(fullWidth, drag.startWidth - (event.clientX - drag.startX)))
    },
    [shellKey, setSSHRightSidebarWidth, fullWidth],
  )

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleDoubleClick = useCallback(() => {
    setSSHRightSidebarWidth(shellKey, DEFAULT_WIDTH)
    setChat(shellKey, { expanded: false })
  }, [shellKey, setSSHRightSidebarWidth, setChat])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Mirrored from ShellSidebar's ArrowLeft/ArrowRight mapping to match
      // this strip's mirrored drag direction above.
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSSHRightSidebarWidth(shellKey, Math.min(fullWidth, displayedWidth + RESIZE_STEP))
        if (expanded) setChat(shellKey, { expanded: false })
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSSHRightSidebarWidth(shellKey, displayedWidth - RESIZE_STEP)
        if (expanded) setChat(shellKey, { expanded: false })
      }
    },
    [shellKey, displayedWidth, expanded, fullWidth, setChat, setSSHRightSidebarWidth],
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
    <>
    {overlayChat && <div aria-hidden="true" className="min-w-0 shrink" style={{ width: expanded ? 40 : displayedWidth + 40 }} />}
    <div ref={sidebarRef} className={cn('flex min-h-0 flex-none', overlayChat && 'absolute inset-y-0 right-0 z-20 bg-devdeck-pane')}>
      <div className="flex min-h-0 flex-none" style={open ? undefined : { display: 'none' }}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={displayedWidth}
          aria-valuemin={SSH_RIGHT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={containerWidth ? fullWidth : SSH_RIGHT_SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          className="w-1 flex-none cursor-col-resize touch-none bg-devdeck-border transition-colors hover:bg-devdeck-line active:bg-devdeck-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        />
        <div className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden bg-devdeck-card-wash" style={{ width: panel === 'chat' ? displayedWidth : Math.min(width, 480), maxWidth: 'calc(100vw - 40px)' }}>
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
            <div className="flex min-w-0 items-center border-b border-devdeck-border">
              <div role="tablist" aria-label="Agent sessions" className="flex min-w-0 flex-1 overflow-x-auto" onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || tabs.length === 0) return
                event.preventDefault()
                const index = tabs.indexOf(active)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                selectThread(tabs[next])
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
              }}>
                {tabs.map((key) => {
                  const session = sessions.data?.find((thread) => thread.id === key)
                  const title = session?.title?.trim() || 'Untitled session'
                  const running = (agentThreads[key]?.status ?? session?.status) === 'running'
                  return <div key={key} className={cn('flex min-w-0 max-w-48 items-center border-b-2', active === key ? 'border-devdeck-line text-devdeck-fg' : 'border-transparent text-devdeck-fg-2')}>
                    <button type="button" role="tab" aria-selected={active === key} tabIndex={active === key ? 0 : -1} data-thread-key={key} title={title} onClick={() => selectThread(key)} className="flex min-w-0 items-center gap-1 px-2 py-2 text-xs">
                      {running && <span aria-label="Running" className="size-1.5 flex-none rounded-full bg-[var(--devdeck-run)]" />}
                      <span className="truncate">{title}</span>
                    </button>
                    <button type="button" aria-label={`Close ${title}`} title="Close tab" onClick={() => closeThread(key)} className="p-1 hover:text-devdeck-fg"><X size={12} /></button>
                  </div>
                })}
              </div>
              <TabStripPopoverMenu trigger={<History size={14} />} triggerTitle="Session history" triggerAriaLabel="Session history" align="end" open={historyOpen} onOpenChange={setHistoryOpen}>
                <div className="flex h-[min(60vh,320px)] w-[248px] flex-col"><SessionsPanel worktreeId={sessionsWorktreeId} machine={executor ?? HUB_MACHINE} activeThreadKey={active} openThreadKeys={tabs} onSelectThread={(key) => { selectThread(key); setHistoryOpen(false) }} onDeleteThread={closeThread} /></div>
              </TabStripPopoverMenu>
              <button type="button" title="New session" aria-label="New session" onClick={newSession} className="p-2 text-devdeck-fg-2 hover:text-devdeck-fg"><Plus size={14} /></button>
              <button type="button" title={expanded ? 'Restore agent' : 'Expand agent'} aria-label={expanded ? 'Restore agent' : 'Expand agent'} onClick={() => setChat(shellKey, { expanded: !expanded })} className="p-2 text-devdeck-fg-2 hover:text-devdeck-fg">{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
            </div>
            {tabs.map((key) => <div key={key} role="tabpanel" className={cn('min-h-0 min-w-0 flex-1 flex-col', key === active ? 'flex' : 'hidden')}>
              <SSHAgentChatPanel connectionId={connectionId} visible={open && panel === 'chat' && key === active} threadKey={key} />
            </div>)}
            {tabs.length === 0 && <div className="flex flex-1 items-center justify-center text-xs text-devdeck-fg-2">Open a session from history or start a new one.</div>}
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
          anchor={tourAnchor('ssh-rail-chat')}
          icon={<Bot size={15} />}
          active={open && panel === 'chat'}
          onClick={() => handleIconClick('chat')}
        />
        {/* No Sessions button here any more. It opened a full-height list that
            replaced the conversation you were reading, and the chat header's
            own history popover (`SSHAgentChatPanel`) reaches the same
            `SessionsPanel` without doing that — two entry points to one list,
            of which this was the worse one. */}
        <RailButton
          label="Stats"
          anchor={tourAnchor('ssh-rail-stats')}
          icon={<Activity size={15} />}
          active={open && panel === 'stats'}
          onClick={() => handleIconClick('stats')}
        />
        <RailButton
          label="Port Forwarding"
          anchor={tourAnchor('ssh-rail-forwards')}
          icon={<Waypoints size={15} />}
          active={open && panel === 'forwards'}
          onClick={() => handleIconClick('forwards')}
        />
      </div>
    </div>
    </>
  )
}

function RailButton({
  label,
  icon,
  active,
  anchor,
  onClick,
}: {
  label: string
  icon: ReactNode
  active: boolean
  /** The guided tour's anchor for this rail entry — every one of the three is
   *  a step in the SSH chapter. */
  anchor?: { 'data-tour': TourAnchor }
  onClick: () => void
}) {
  return (
    <button
      type="button"
      {...anchor}
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
