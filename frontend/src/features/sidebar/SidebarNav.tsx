import { useNavigate } from '@tanstack/react-router'
import { SquareTerminal, LayoutGrid, Server, Wrench, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import type { ModuleView } from '@/store/types'

interface RailDef {
  key: Extract<ModuleView, 'agents' | 'ssh' | 'database' | 'tools' | 'invoices' | 'machines'>
  label: string
  Icon: LucideIcon
  badge?: number
}

interface SidebarNavProps {
  compact?: boolean
}

export function SidebarNav({ compact: _compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const workspace = useWorkspace(wsId)
  const ws = workspace.data
  const runningHosts = ws?.projects.flatMap((project) => project.worktrees).filter((worktree) => worktree.state === 'running').length ?? 0

  const items: RailDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: runningHosts },
    { key: 'machines', label: 'Runtimes', Icon: Server },
    { key: 'ssh', label: 'SSH', Icon: SquareTerminal },
    { key: 'tools', label: 'Tools', Icon: Wrench },
  ]

  function goto(key: RailDef['key']) {
    if (!wsId) return
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'machines') navigate({ to: '/w/$wsId/machines', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  return (
    <nav className="flex w-full flex-none flex-col items-center gap-1 px-2 py-2" aria-label="Primary menu">
      {items.map((item) => {
        const active = view === item.key
        // Gate on `isSuccess`, not on the count: rendering `?? 0` immediately
        // makes the badge pop 0 → N a beat after first paint.
        const showBadge = workspace.isSuccess && !!item.badge
        return (
          <Tooltip key={item.key} label={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => goto(item.key)}
              className={cn(
                'group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-control transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-devdeck-on text-devdeck-fg'
                  : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              )}
            >
              {/* Active marker at the rail's own edge. An inset ring — what this
                  replaces — is invisible in peripheral vision; a bar at the
                  container edge is not. */}
              <span
                aria-hidden
                className={cn(
                  'absolute -left-2 h-4 w-0.5 rounded-r-full bg-devdeck-ring transition-opacity duration-150',
                  active ? 'opacity-100' : 'opacity-0',
                )}
              />
              <item.Icon size={18} strokeWidth={active ? 2.2 : 1.9} />
              {showBadge ? (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-devdeck-green ring-2 ring-devdeck-pane" />
              ) : null}
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}
