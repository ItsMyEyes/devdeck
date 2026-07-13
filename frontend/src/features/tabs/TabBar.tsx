import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { LayoutGrid, Plus, X } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { StatusDot } from '@/components/ui/status-dot'

interface TabBarProps {
  wsId: string
}

/** Width reserved on the left for macOS's overlaid traffic-light buttons
 *  (see tauri.macos.conf.json's titleBarStyle: "Overlay" + hiddenTitle).
 *  This div is also the drag region that lets the whole gutter move the
 *  window, since there's no native title bar left to grab. */
const TRAFFIC_LIGHT_GUTTER = 76

/** Chrome-style window-wide tab bar, Tauri desktop only: a pinned "Agents"
 *  home tab plus one closable tab per opened worktree. Mounted above
 *  Header/Sidebar/ExpandedTerminal in WorkspaceLayout, on every workspace
 *  route (not just the worktree terminal). Also doubles as the window's
 *  title bar (macOS overlay style — see tauri.macos.conf.json), so its
 *  empty space is a drag region via data-tauri-drag-region. */
export function TabBar({ wsId }: TabBarProps) {
  const navigate = useNavigate()
  const { wtId: activeWtId, projectId: currentProjectId } = useParams({ strict: false }) as {
    wtId?: string
    projectId?: string
  }
  const openTabs = useLoomStore((s) => s.openTabs[wsId] ?? [])
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []

  // Drop tabs for worktrees deleted while the app was closed (or by another tab).
  useEffect(() => {
    if (!workspace) return
    pruneWorktreeTabs(
      wsId,
      new Set(worktrees.map((w) => w.id)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, wsId])

  // "+" spawns a worktree in whichever project is currently in view (falls
  // back to the workspace's first project on non-project routes, e.g.
  // Machines/Tools) — the new worktree becomes a tab itself once created,
  // via the same openWorktreeTab call SpawnDialog's onSuccess already makes.
  function handleNewTab() {
    const targetProjectId = currentProjectId ?? workspace?.projects[0]?.id
    if (!targetProjectId) {
      showToast('Add a project first')
      return
    }
    openSpawn(targetProjectId)
  }

  function closeTab(wtId: string) {
    const idx = openTabs.findIndex((t) => t.wtId === wtId)
    const wasActive = wtId === activeWtId
    closeWorktreeTab(wsId, wtId)
    if (!wasActive) return
    const remaining = openTabs.filter((t) => t.wtId !== wtId)
    const next = remaining[idx] ?? remaining[idx - 1]
    if (next) {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: next.projectId, wtId: next.wtId },
      })
    } else {
      navigate({ to: '/w/$wsId', params: { wsId } })
    }
  }

  // Cmd+W closes the active worktree tab; Cmd+Shift+[ / ] cycles tabs
  // (including the pinned Agents tab as position 0). metaKey only — Ctrl+W
  // and Ctrl+T are already bound inside ExpandedTerminal's own handler.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!event.metaKey) return
      if (event.key.toLowerCase() === 'w') {
        if (!activeWtId) return
        event.preventDefault()
        closeTab(activeWtId)
        return
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const order: (string | undefined)[] = [undefined, ...openTabs.map((t) => t.wtId)]
        const from = order.indexOf(activeWtId)
        const delta = event.key === ']' ? 1 : -1
        const to = order[(from + delta + order.length) % order.length]
        if (!to) {
          navigate({ to: '/w/$wsId', params: { wsId } })
          return
        }
        const tab = openTabs.find((t) => t.wtId === to)
        if (tab) {
          navigate({
            to: '/w/$wsId/p/$projectId/wt/$wtId',
            params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
          })
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs, activeWtId, wsId])

  return (
    <div className="flex h-10 flex-none items-center overflow-x-auto border-b border-loom-border bg-loom-surface">
      {/* Reserved for macOS's overlaid traffic-light buttons; empty space here is a drag handle. */}
      <div data-tauri-drag-region className="h-full flex-none" style={{ width: TRAFFIC_LIGHT_GUTTER }} />

      <button
        type="button"
        onClick={() => navigate({ to: '/w/$wsId', params: { wsId } })}
        className={cn(
          'flex h-7 flex-none items-center gap-1.5 rounded-lg px-2.5 font-mono text-[11.5px]',
          !activeWtId ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
        )}
      >
        <LayoutGrid size={12} />
        Agents
      </button>

      <div className="mx-1.5 h-4 w-px flex-none bg-loom-border-menu" />

      <div className="flex items-center gap-1">
        {openTabs.map((t) => {
          const worktree = worktrees.find((w) => w.id === t.wtId)
          if (!worktree) return null
          const st = STATE[worktree.state]
          const label = worktree.root ? 'project root' : worktree.branch
          const active = t.wtId === activeWtId
          return (
            <div
              key={t.wtId}
              className={cn(
                'group flex h-7 max-w-[180px] flex-none items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 font-mono text-[11.5px]',
                active ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
              )}
            >
              <button
                type="button"
                onClick={() =>
                  navigate({
                    to: '/w/$wsId/p/$projectId/wt/$wtId',
                    params: { wsId, projectId: t.projectId, wtId: t.wtId },
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-1.5"
              >
                <StatusDot color={st.color} pulse={worktree.state === 'running' || worktree.state === 'waiting'} />
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.wtId)}
                aria-label={`Close ${label}`}
                className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={handleNewTab}
        aria-label="New worktree"
        className="ml-1 flex h-7 w-7 flex-none items-center justify-center rounded-lg text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg"
      >
        <Plus size={13} />
      </button>

      {/* Remaining empty bar space stays draggable, matching the reference layout. */}
      <div data-tauri-drag-region className="h-full flex-1" />
    </div>
  )
}
