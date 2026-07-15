import { Popover } from '@base-ui/react/popover'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, Plus, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspaces } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

interface WorkspaceSwitcherProps {
  /** Icon-only, non-interactive badge for the collapsed sidebar rail. */
  compact?: boolean
}

export function WorkspaceSwitcher({ compact }: WorkspaceSwitcherProps = {}) {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const workspaces = useWorkspaces().data ?? []
  const open = useLoomStore((s) => s.wsMenuOpen)
  const toggle = useLoomStore((s) => s.toggleWsMenu)
  const closeMenu = useLoomStore((s) => s.closeWsMenu)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const openNewWorkspace = useLoomStore((s) => s.openNewWorkspace)
  const openEdit = useLoomStore((s) => s.openEdit)

  const active = workspaces.find((w) => w.id === wsId) ?? workspaces[0]

  function switchTo(id: string) {
    closeMenu()
    setSidebarOpen(false)
    // The WorkspaceLayout effect keeps the server's active workspace in sync with
    // the URL, so navigation alone is enough — no explicit settings PATCH here.
    navigate({ to: '/w/$wsId', params: { wsId: id } })
  }

  if (compact) {
    return (
      <div className="flex flex-none items-center justify-center border-b border-loom-border py-2.5">
        <WorkspaceBadge name={active?.name ?? '?'} active small />
      </div>
    )
  }

  return (
    <div className="relative flex-none border-b border-t border-loom-border p-3 pb-[9px]">
      <Popover.Root open={open} onOpenChange={(o) => (o ? toggle() : closeMenu())}>
        <Popover.Trigger
          className={cn(
            'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-loom-border-strong bg-loom-surface-2 px-2.5 text-left',
            'transition-colors hover:border-loom-border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          <WorkspaceBadge name={active?.name ?? '?'} active />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-loom-dim">WORKSPACE</div>
            <div className="mt-px truncate text-[12.5px] font-semibold text-loom-fg">{active?.name ?? '—'}</div>
          </div>
          <ChevronDown size={13} className="flex-none text-loom-dim" />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 45 }} className="outline-none">
            <Popover.Popup
              className={cn(
                'w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-[11px] border border-loom-border-menu bg-loom-popover p-1.5',
                'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              {workspaces.map((w) => {
                const isActive = w.id === active?.id
                return (
                  <div
                    key={w.id}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? true : undefined}
                    onClick={() => switchTo(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        switchTo(w.id)
                      }
                    }}
                    className={cn(
                      'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      isActive ? 'bg-loom-accent/10' : 'hover:bg-loom-hover-wash',
                    )}
                  >
                    <WorkspaceBadge name={w.name} active={isActive} small />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-loom-fg-2">{w.name}</span>
                    <span className="font-mono text-[10px] text-loom-dim">{w.projects.length}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit('workspace', w.id, { a: w.name })
                      }}
                      aria-label={`Edit ${w.name}`}
                      className="cursor-pointer p-0.5 text-loom-dim hover:text-loom-accent-soft"
                    >
                      <Settings2 size={13} />
                    </button>
                    <span className="w-3 text-center text-loom-accent">{isActive ? '✓' : ''}</span>
                  </div>
                )
              })}
              <button
                onClick={openNewWorkspace}
                className="mt-1 flex h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-b-lg border-t border-loom-border-strong px-2.5 text-[12.5px] text-loom-muted hover:text-loom-fg"
              >
                <Plus size={15} className="w-5" />
                New workspace
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function WorkspaceBadge({ name, active, small }: { name: string; active: boolean; small?: boolean }) {
  const s = small ? 22 : 20
  return (
    <span
      className="flex flex-none items-center justify-center font-semibold text-[9.5px]"
      style={{
        width: s,
        height: s,
        borderRadius: small ? 7 : 6,
        background: active ? 'var(--loom-accent-gradient)' : 'var(--loom-border-strong)',
        color: active ? 'var(--loom-accent-ink)' : 'var(--loom-muted)',
      }}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  )
}
