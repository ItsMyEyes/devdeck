import { cloneElement } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Blocks, Globe, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'
import type { ModuleView } from '@/store/types'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { Tooltip } from '@/components/ui/tooltip'

interface NavDef {
  key: ModuleView
  label: string
  Icon: LucideIcon
  badge: number
}

interface SidebarNavProps {
  /** Icon-only buttons with hover tooltips, for the collapsed sidebar rail. */
  compact?: boolean
}

export function SidebarNav({ compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data

  const worktrees = ws ? ws.projects.flatMap((p) => p.worktrees) : []
  const running = worktrees.filter((w) => w.state === 'running').length
  const openInvoices = ws ? ws.invoices.filter((iv) => iv.status === 'sent' || iv.status === 'overdue').length : 0

  const items: NavDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: running },
    { key: 'management', label: 'Agent management', Icon: Blocks, badge: 0 },
    { key: 'invoices', label: 'Invoices', Icon: Receipt, badge: openInvoices },
    { key: 'browser', label: 'Browser', Icon: Globe, badge: 0 },
    { key: 'tools', label: 'Tools', Icon: Wrench, badge: 0 },
    { key: 'machines', label: 'Machines', Icon: Server, badge: 0 },
  ]

  function goto(key: ModuleView) {
    if (!wsId) return
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'management') navigate({ to: '/w/$wsId/management', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  return (
    <div
      className={cn(
        'flex flex-none gap-0.5 border-b border-loom-border p-2',
        compact ? 'flex-col items-center' : 'flex-col',
      )}
    >
      {items.map((n) => {
        const active = view === n.key
        const button = (
          <button
            onClick={() => goto(n.key)}
            aria-label={n.label}
            className={cn(
              'relative flex cursor-pointer items-center rounded-lg text-[12.5px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              compact ? 'h-9 w-9 justify-center' : 'h-[34px] gap-2.5 px-2.5',
              active
                ? 'bg-loom-accent/10 text-loom-fg shadow-[inset_2px_0_0_var(--loom-accent)]'
                : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
            )}
          >
            <n.Icon size={14} className={cn('flex-none', active && 'text-loom-accent')} />
            {!compact && <span className="min-w-0 flex-1 text-left">{n.label}</span>}
            {n.badge > 0 &&
              (compact ? (
                <span className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full bg-loom-accent" />
              ) : (
                <span
                  className={cn(
                    'min-w-[16px] rounded-md px-[5px] py-px text-center font-mono text-[9.5px] font-semibold',
                    active ? 'bg-loom-accent text-loom-accent-ink' : 'bg-loom-accent/15 text-loom-accent-soft',
                  )}
                >
                  {n.badge}
                </span>
              ))}
          </button>
        )
        return compact ? (
          <Tooltip key={n.key} label={n.label} side="right">
            {button}
          </Tooltip>
        ) : (
          cloneElement(button, { key: n.key })
        )
      })}
    </div>
  )
}
