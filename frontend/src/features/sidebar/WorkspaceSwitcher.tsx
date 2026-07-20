import { Popover } from '@base-ui/react/popover'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWhoami, useWorkspaces } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { Tooltip } from '@/components/ui/tooltip'
import type { Workspace } from '@/store/types'
import { NeverSyncedNotice } from './NeverSyncedNotice'

interface WorkspaceSwitcherProps {
  /** Compact trigger for the sidebar rail. Still opens the workspace menu. */
  compact?: boolean
}

export function WorkspaceSwitcher({ compact }: WorkspaceSwitcherProps = {}) {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const workspaces = useWorkspaces().data ?? []
  const open = useDevDeckStore((s) => s.wsMenuOpen)
  const toggle = useDevDeckStore((s) => s.toggleWsMenu)
  const closeMenu = useDevDeckStore((s) => s.closeWsMenu)
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const openNewWorkspace = useDevDeckStore((s) => s.openNewWorkspace)
  const openEdit = useDevDeckStore((s) => s.openEdit)

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
          'bg-devdeck-surface-2 text-devdeck-muted transition-colors hover:border-devdeck-border-accent hover:bg-devdeck-popover hover:text-devdeck-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          open && 'border-devdeck-border-accent bg-devdeck-popover text-devdeck-fg',
        )}
      >
        <WorkspaceBadge name={active?.name ?? '?'} active={open} small />
      </Popover.Trigger>
    </Tooltip>
  ) : (
    <Popover.Trigger
      className={cn(
        'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-surface-2 px-2.5 text-left',
        'transition-colors hover:border-devdeck-border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      <WorkspaceBadge name={active?.name ?? '?'} active />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[8.5px] tracking-[0.14em] text-devdeck-dim">WORKSPACE</div>
        <div className="mt-px truncate text-[12.5px] font-semibold text-devdeck-fg">{active?.name ?? '—'}</div>
      </div>
      <ChevronDown size={13} className="flex-none text-devdeck-dim" />
    </Popover.Trigger>
  )

  return (
    <div className={cn('relative flex flex-none items-center justify-center border-b border-devdeck-border', compact ? 'py-2' : 'border-t p-3 pb-[9px]')}>
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
                'origin-[var(--transform-origin)] rounded-[12px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                'shadow-[0_12px_28px_rgba(0,0,0,0.48)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="min-w-0">
                  <div className="font-mono text-[9px] font-semibold tracking-[0.14em] text-devdeck-dim">WORKSPACE</div>
                  <div className="mt-0.5 truncate text-[12px] text-devdeck-muted">
                    {active ? `${active.projects.length} groups · ${activeHosts} agents` : 'No workspace selected'}
                  </div>
                </div>
                <ChevronDown size={13} className="flex-none text-devdeck-dim" />
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
                className="mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-t border-devdeck-border-strong px-2 text-[12px] font-medium text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
  const whoami = useWhoami().data
  // Same lookalike-empty-state guard as ProjectTree: a runtime that has
  // never pulled a catalog must not look identical to a genuinely empty one.
  const neverSynced = whoami?.role === 'runtime' && whoami.lastSyncedAt === null

  if (workspaces.length === 0) {
    if (neverSynced) {
      return <NeverSyncedNotice lastSyncedAt={null} />
    }
    return <div className="px-2 py-5 text-center text-[12px] text-devdeck-dim">No workspaces yet</div>
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
                ? 'bg-devdeck-accent-tint text-devdeck-fg ring-1 ring-inset ring-devdeck-border-accent'
                : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
            )}
          >
            <WorkspaceBadge name={workspace.name} active={isActive} small />
            <div className="min-w-0 flex-1">
              <div className={cn('truncate text-[12.5px] font-semibold', isActive ? 'text-devdeck-fg' : 'text-devdeck-fg-2')}>
                {workspace.name}
              </div>
              <div className="mt-0.5 truncate font-mono text-[9.5px] text-devdeck-dim">
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
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-devdeck-dim opacity-80 hover:bg-devdeck-hover-wash hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Settings2 size={12} />
            </button>
            <span className="flex h-5 w-5 items-center justify-center text-devdeck-accent-soft">
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
        background: active ? '#1b2744' : 'var(--devdeck-surface-2)',
        borderColor: active ? 'var(--devdeck-border-accent)' : 'var(--devdeck-border-card)',
        color: active ? '#8fb1ff' : 'var(--devdeck-muted)',
      }}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  )
}
