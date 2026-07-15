import { cloneElement, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Blocks, Cable, Globe, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'
import type { ModuleView } from '@/store/types'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useLoomStore } from '@/store/useLoomStore'
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

/** Icon-only rail buttons are easy to fat-finger while aiming for the terminal/editor next to
 *  them, so a single click there only "arms" the item (forcing its tooltip open as a name
 *  confirmation) instead of navigating; a second click within this window confirms it. Purely
 *  cosmetic in the expanded sidebar, where labels are already visible next to each icon. */
const ARM_TIMEOUT_MS = 2500

export function SidebarNav({ compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const isTauri = useIsTauri()
  const openBrowserTab = useLoomStore((s) => s.openBrowserTab)
  const [hoveredKey, setHoveredKey] = useState<ModuleView | null>(null)
  const [armedKey, setArmedKey] = useState<ModuleView | null>(null)

  useEffect(() => {
    if (!armedKey) return
    const timer = window.setTimeout(() => setArmedKey(null), ARM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [armedKey])

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
    { key: 'ssh', label: 'SSH', Icon: Cable, badge: 0 },
  ]

  function goto(key: ModuleView) {
    if (!wsId) return
    // Desktop: a Browser click opens a new machine-proxied Browser tile in
    // the workspace tab strip instead of the web's sandboxed-iframe route.
    if (key === 'browser' && isTauri) {
      openBrowserTab(wsId)
      navigate({ to: '/w/$wsId', params: { wsId } })
      return
    }
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'management') navigate({ to: '/w/$wsId/management', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  /** Compact rail: first click arms the item (tooltip pops open as a name check); a second
   *  click while armed confirms and navigates. Expanded sidebar navigates on the first click
   *  as before — the label is already visible, so there's nothing to mis-click into. */
  function handleClick(key: ModuleView) {
    if (!compact) {
      goto(key)
      return
    }
    if (armedKey === key) {
      setArmedKey(null)
      goto(key)
    } else {
      setArmedKey(key)
    }
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
        const armed = compact && armedKey === n.key
        const button = (
          <button
            onClick={() => handleClick(n.key)}
            onMouseEnter={compact ? () => setHoveredKey(n.key) : undefined}
            onMouseLeave={
              compact
                ? () => {
                    setHoveredKey((k) => (k === n.key ? null : k))
                    setArmedKey((k) => (k === n.key ? null : k))
                  }
                : undefined
            }
            onFocus={compact ? () => setHoveredKey(n.key) : undefined}
            onBlur={compact ? () => setHoveredKey((k) => (k === n.key ? null : k)) : undefined}
            aria-label={n.label}
            className={cn(
              'relative flex cursor-pointer items-center rounded-lg text-[12.5px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              compact ? 'h-9 w-9 justify-center' : 'h-[34px] gap-2.5 px-2.5',
              armed && 'ring-2 ring-loom-accent/70',
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
          <Tooltip key={n.key} label={n.label} side="right" open={hoveredKey === n.key || armed}>
            {button}
          </Tooltip>
        ) : (
          cloneElement(button, { key: n.key })
        )
      })}
    </div>
  )
}
