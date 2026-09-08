import { useNavigate } from '@tanstack/react-router'
import { BrainCog, SquareTerminal, LayoutGrid, Server, Wrench, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useScope } from '@/features/useScope'
import { tourAnchor } from '@/features/tour/tourAnchors'
import { useWorkspace } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { ModuleView } from '@/store/types'

interface RailDef {
  key: Extract<ModuleView, 'agents' | 'ssh' | 'database' | 'tools' | 'invoices' | 'machines' | 'memory'>
  label: string
  Icon: LucideIcon
  badge?: number
}

interface SidebarNavProps {
  /** `true` (the default) is the 56px icon rail. `false` is the labelled list
   *  the mobile drawer uses — there the rail's hover tooltips are unreachable
   *  on touch, so the labels have to be on screen. */
  compact?: boolean
}

export function SidebarNav({ compact = true }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const selectAgentsTab = useDevDeckStore((s) => s.selectAgentsTab)
  const workspace = useWorkspace(wsId)
  const ws = workspace.data
  const runningHosts = ws?.projects.flatMap((project) => project.worktrees).filter((worktree) => worktree.state === 'running').length ?? 0

  const items: RailDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: runningHosts },
    { key: 'ssh', label: 'SSH', Icon: SquareTerminal },
    { key: 'machines', label: 'Runtimes', Icon: Server },
    { key: 'tools', label: 'Tools', Icon: Wrench },
    { key: 'memory', label: 'Memory', Icon: BrainCog },
  ]

  function goto(key: RailDef['key']) {
    if (!wsId) return
    if (key === 'agents') {
      // An ssh-shell tile resolves to the bare `/w/$wsId` as well (see
      // WorkspaceTileArea's `navigateToTab`), so from one the navigate below
      // is a no-op — same URL, same focused tab, Agents stays unreachable.
      // Selecting the pinned Agents tab is what actually moves the view, the
      // same pairing ProjectTree's "All agents" row uses.
      selectAgentsTab(wsId)
      navigate({ to: '/w/$wsId', params: { wsId } })
    } else if (key === 'machines') navigate({ to: '/w/$wsId/machines', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  return (
    <nav
      {...tourAnchor('nav-rail')}
      className={cn(
        'flex w-full flex-none flex-col gap-1 py-2',
        compact ? 'items-center px-2' : 'items-stretch px-2',
      )}
      aria-label="Primary menu"
    >
      {items.map((item) => {
        const active = view === item.key
        // Gate on `isSuccess`, not on the count: rendering `?? 0` immediately
        // makes the badge pop 0 → N a beat after first paint.
        const showBadge = workspace.isSuccess && !!item.badge
        const button = (
          <button
            type="button"
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => goto(item.key)}
            className={cn(
              'group relative flex cursor-pointer items-center rounded-control transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              // 44px tall in the labelled list: the drawer is driven by thumbs,
              // and the rail's 40px square is below the comfortable touch target.
              compact ? 'h-10 w-10 justify-center' : 'h-11 w-full gap-3 px-3 text-[13px] font-medium',
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
                'absolute h-4 w-0.5 rounded-r-full bg-devdeck-ring transition-opacity duration-150',
                compact ? '-left-2' : 'left-0',
                active ? 'opacity-100' : 'opacity-0',
              )}
            />
            <item.Icon size={18} strokeWidth={active ? 2.2 : 1.9} className="flex-none" />
            {compact ? null : <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>}
            {showBadge ? (
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full bg-devdeck-green',
                  compact ? 'absolute right-1.5 top-1.5 ring-2 ring-devdeck-pane' : 'mr-1 flex-none',
                )}
              />
            ) : null}
          </button>
        )
        // The label is already on screen in the drawer, and a hover tooltip on a
        // touch target only gets in the way there.
        return compact ? (
          <Tooltip key={item.key} label={item.label} side="right">
            {button}
          </Tooltip>
        ) : (
          <div key={item.key}>{button}</div>
        )
      })}
    </nav>
  )
}
