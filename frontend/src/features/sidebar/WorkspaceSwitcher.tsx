import { Popover } from '@base-ui/react/popover'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspaces } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { Tooltip } from '@/components/ui/tooltip'
import type { Workspace } from '@/store/types'

interface WorkspaceSwitcherProps {
  /** Compact trigger for the sidebar rail. Still opens the workspace menu. */
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
  const activeHosts = active?.projects.reduce((total, project) => total + project.worktrees.length, 0) ?? 0

  function switchTo(id: string) {
    closeMenu()
    setSidebarOpen(false)
    // The WorkspaceLayout effect keeps the server's active workspace in sync with
    // the URL, so navigation alone is enough — no explicit settings PATCH here.
    navigate({ to: '/w/$wsId', params: { wsId: id } })
  }

  const trigger = compact ? (
    <Tooltip label={active ? `Workspace: ${active.name}` : 'Select workspace'} side="right">
      <Popover.Trigger
        aria-label={active ? `Select workspace, current workspace ${active.name}` : 'Select workspace'}
        className={cn(
          'group flex h-10 w-10 cursor-pointer items-center justify-center rounded-[11px] border border-transparent',
          'bg-loom-surface-2 text-loom-muted transition-colors hover:border-loom-border-accent hover:bg-loom-popover hover:text-loom-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          open && 'border-loom-border-accent bg-loom-popover text-loom-fg',
        )}
      >
        <WorkspaceBadge name={active?.name ?? '?'} active={open} small />
      </Popover.Trigger>
    </Tooltip>
  ) : (
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
  )

  return (
    <div className={cn('relative flex flex-none items-center justify-center border-b border-loom-border', compact ? 'py-2' : 'border-t p-3 pb-[9px]')}>
      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && !open) toggle()
          if (!nextOpen) closeMenu()
        }}
      >
        {trigger}

        <Popover.Portal>
          <Popover.Positioner
            side={compact ? 'right' : 'bottom'}
            align="start"
            sideOffset={compact ? 8 : 6}
            alignOffset={compact ? -4 : 0}
            style={{ zIndex: 45 }}
            className="outline-none"
          >
            <Popover.Popup
              className={cn(
                compact ? 'w-[260px]' : 'w-[var(--anchor-width)] min-w-[260px]',
                'origin-[var(--transform-origin)] rounded-[12px] border border-loom-border-menu bg-loom-popover p-1.5',
                'shadow-[0_12px_28px_rgba(0,0,0,0.48)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="min-w-0">
                  <div className="font-mono text-[9px] font-semibold tracking-[0.14em] text-loom-dim">WORKSPACE</div>
                  <div className="mt-0.5 truncate text-[12px] text-loom-muted">
                    {active ? `${active.projects.length} groups · ${activeHosts} agents` : 'No workspace selected'}
                  </div>
                </div>
                <ChevronDown size={13} className="flex-none text-loom-dim" />
              </div>

              <WorkspaceMenu
                workspaces={workspaces}
                activeId={active?.id}
                onSwitch={switchTo}
                onEdit={(workspace) => openEdit('workspace', workspace.id, { a: workspace.name })}
              />

              <button
                type="button"
                onClick={openNewWorkspace}
                className="mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-t border-loom-border-strong px-2 text-[12px] font-medium text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Plus size={14} className="w-5" />
                New workspace
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function WorkspaceMenu({
  workspaces,
  activeId,
  onSwitch,
  onEdit,
}: {
  workspaces: Workspace[]
  activeId?: string
  onSwitch: (id: string) => void
  onEdit: (workspace: Workspace) => void
}) {
  if (workspaces.length === 0) {
    return <div className="px-2 py-5 text-center text-[12px] text-loom-dim">No workspaces yet</div>
  }

  return (
    <div className="max-h-[320px] overflow-auto py-1">
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId
        const hostCount = workspace.projects.reduce((total, project) => total + project.worktrees.length, 0)
        return (
          <div
            key={workspace.id}
            role="button"
            tabIndex={0}
            aria-current={isActive ? true : undefined}
            onClick={() => onSwitch(workspace.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSwitch(workspace.id)
              }
            }}
            className={cn(
              'group flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              isActive
                ? 'bg-loom-accent-tint text-loom-fg ring-1 ring-inset ring-loom-border-accent'
                : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
            )}
          >
            <WorkspaceBadge name={workspace.name} active={isActive} small />
            <div className="min-w-0 flex-1">
              <div className={cn('truncate text-[12.5px] font-semibold', isActive ? 'text-loom-fg' : 'text-loom-fg-2')}>
                {workspace.name}
              </div>
              <div className="mt-0.5 truncate font-mono text-[9.5px] text-loom-dim">
                {workspace.projects.length} groups · {hostCount} agents
              </div>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onEdit(workspace)
              }}
              aria-label={`Edit ${workspace.name}`}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-loom-dim opacity-80 hover:bg-loom-hover-wash hover:text-loom-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Settings2 size={12} />
            </button>
            <span className="flex h-5 w-5 items-center justify-center text-loom-accent-soft">
              {isActive ? <Check size={13} strokeWidth={2.5} /> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function WorkspaceBadge({ name, active, small }: { name: string; active: boolean; small?: boolean }) {
  const s = small ? 24 : 22
  return (
    <span
      className="flex flex-none items-center justify-center border font-mono text-[9px] font-bold tracking-[0.02em]"
      style={{
        width: s,
        height: s,
        borderRadius: small ? 8 : 7,
        background: active ? '#1b2744' : 'var(--loom-surface-2)',
        borderColor: active ? 'var(--loom-border-accent)' : 'var(--loom-border-card)',
        color: active ? '#8fb1ff' : 'var(--loom-muted)',
      }}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  )
}
