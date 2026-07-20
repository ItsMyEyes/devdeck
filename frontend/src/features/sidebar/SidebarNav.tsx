import { useNavigate } from '@tanstack/react-router'
import { Cable, Database, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'
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
  const ws = useWorkspace(wsId).data
  const runningHosts = ws?.projects.flatMap((project) => project.worktrees).filter((worktree) => worktree.state === 'running').length ?? 0
  const openInvoices = ws?.invoices.filter((invoice) => invoice.status === 'sent' || invoice.status === 'overdue').length ?? 0

  const items: RailDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: runningHosts },
    { key: 'machines', label: 'Runtimes', Icon: Server },
    { key: 'ssh', label: 'SSH', Icon: Cable },
    { key: 'database', label: 'Database', Icon: Database },
    { key: 'tools', label: 'Tools', Icon: Wrench },
    { key: 'invoices', label: 'Invoices', Icon: Receipt, badge: openInvoices },
  ]

  function goto(key: RailDef['key']) {
    if (!wsId) return
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'machines') navigate({ to: '/w/$wsId/machines', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  return (
    <nav className="flex flex-none flex-col items-center gap-1.5 px-2 py-2" aria-label="Primary menu">
      {items.map((item) => {
        const active = view === item.key
        return (
          <Tooltip key={item.key} label={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => goto(item.key)}
              className={cn(
                'group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-[11px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-devdeck-accent-tint text-devdeck-accent-soft ring-1 ring-inset ring-devdeck-border-accent'
                  : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              )}
            >
              <item.Icon size={18} strokeWidth={active ? 2.2 : 1.9} />
              {item.badge ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-devdeck-accent-soft" /> : null}
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}
