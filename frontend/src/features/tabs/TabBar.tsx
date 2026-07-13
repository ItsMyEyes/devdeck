import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { LayoutGrid, X } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { StatusDot } from '@/components/ui/status-dot'

interface TabBarProps {
  wsId: string
}

/** Chrome-style window-wide tab bar, Tauri desktop only: a pinned "Agents"
 *  home tab plus one closable tab per opened worktree. Mounted above
 *  Header/Sidebar/ExpandedTerminal in WorkspaceLayout, on every workspace
 *  route (not just the worktree terminal). */
export function TabBar({ wsId }: TabBarProps) {
  const navigate = useNavigate()
  const { wtId: activeWtId } = useParams({ strict: false }) as { wtId?: string }
  const openTabs = useLoomStore((s) => s.openTabs[wsId] ?? [])
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
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
    <div className="flex h-9 flex-none items-center gap-1 overflow-x-auto border-b border-loom-border bg-loom-surface px-1.5">
      <button
        type="button"
        onClick={() => navigate({ to: '/w/$wsId', params: { wsId } })}
        className={cn(
          'flex h-7 flex-none items-center gap-1.5 rounded-t-md px-2.5 font-mono text-[11.5px]',
          !activeWtId ? 'bg-loom-bg text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
        )}
      >
        <LayoutGrid size={12} />
        Agents
      </button>

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
              'group flex h-7 max-w-[180px] flex-none items-center gap-1.5 rounded-t-md pl-2.5 pr-1.5 font-mono text-[11.5px]',
              active ? 'bg-loom-bg text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
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
  )
}
