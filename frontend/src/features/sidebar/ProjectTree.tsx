import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, Folder, LayoutGrid, Plus, Settings2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATE } from '@/lib/constants'
import { worktreeLabel } from '@/lib/worktreeLabel'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip } from '@/components/ui/tooltip'
import { useScope } from '@/features/useScope'
import { useMachineHealth, useMachines, useUpdateProject, useWhoami, useWorkspace } from '@/features/data/queries'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { Project, Worktree } from '@/store/types'
import { NeverSyncedNotice } from './NeverSyncedNotice'
import { ProjectSyncBadge } from './ProjectSyncBadge'

const GROUP_COLORS = ['#ff6978', '#4aa8ff', '#a578ff', '#5ed69a', '#f5c451', '#c7a3ff']

export function ProjectTree() {
  const navigate = useNavigate()
  const { wsId, projectId, wtId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const updateProject = useUpdateProject()
  const isTauri = useIsTauri()
  const openNewProject = useDevDeckStore((s) => s.openNewProject)
  const openEdit = useDevDeckStore((s) => s.openEdit)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const openWorktreeTab = useDevDeckStore((s) => s.openWorktreeTab)
  const selectAgentsTab = useDevDeckStore((s) => s.selectAgentsTab)
  const whoami = useWhoami().data
  // A runtime that has never pulled a catalog (wrong --hub-key, hub
  // unreachable since boot) has an empty replica indistinguishable from a
  // genuinely empty account unless we check lastSyncedAt explicitly.
  const neverSynced = whoami?.role === 'runtime' && whoami.lastSyncedAt === null
  const projects = ws?.projects ?? []
  const totalHosts = projects.reduce((total, project) => total + project.worktrees.length, 0)
  const allSelected = view === 'agents' && !projectId

  function goAllHosts() {
    if (!wsId) return
    selectAgentsTab(wsId)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }

  function goProject(project: Project) {
    if (!wsId) return
    selectAgentsTab(wsId)
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId: project.id } })
  }

  function toggleProject(project: Project) {
    updateProject.mutate({ id: project.id, patch: { expanded: !project.expanded } })
  }

  function openWorktree(project: Project, worktree: Worktree) {
    if (!wsId) return
    if (isTauri) openWorktreeTab(wsId, project.id, worktree.id)
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId: project.id, wtId: worktree.id } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-4">
      <div className="mb-2.5 flex items-center justify-between px-2">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.16em] text-devdeck-dim">GROUPS</span>
        <button
          type="button"
          onClick={openNewProject}
          title="New project"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <button
          type="button"
          onClick={goAllHosts}
          aria-current={allSelected ? 'page' : undefined}
          className={cn(
            'mb-2.5 flex h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            allSelected
              ? 'bg-devdeck-accent-tint text-devdeck-accent-soft ring-1 ring-inset ring-devdeck-border-accent'
              : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
          )}
        >
          <LayoutGrid size={17} className="flex-none" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">All agents</span>
          <span className="rounded-full bg-black/10 px-2 py-0.5 font-mono text-[11px] font-semibold opacity-85">{totalHosts}</span>
        </button>

        <div className="flex flex-col gap-1">
          {projects.map((project, index) => (
            <ProjectRow
              key={project.id}
              project={project}
              color={GROUP_COLORS[index % GROUP_COLORS.length]}
              selected={view === 'agents' && projectId === project.id && !wtId}
              wtId={wtId}
              onGoProject={() => goProject(project)}
              onToggle={() => toggleProject(project)}
              onOpenWorktree={(worktree) => openWorktree(project, worktree)}
              onEdit={() => openEdit('project', project.id, { a: project.name, b: project.path })}
              onDelete={() => askDelete('project', project.id, project.name)}
            />
          ))}
        </div>

        {projects.length === 0 ? (
          neverSynced ? (
            <NeverSyncedNotice lastSyncedAt={null} />
          ) : (
            <div className="px-3 py-8 text-center">
              <div className="font-mono text-[11.5px] text-devdeck-dim">no groups yet</div>
              <button
                type="button"
                onClick={openNewProject}
                className="mt-3 h-8 cursor-pointer rounded-md border border-devdeck-border-menu bg-devdeck-elevated px-3 text-[12px] font-semibold text-devdeck-fg-2 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                + Add project
              </button>
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}

function ProjectRow({
  project,
  color,
  selected,
  wtId,
  onGoProject,
  onToggle,
  onOpenWorktree,
  onEdit,
  onDelete,
}: {
  project: Project
  color: string
  selected: boolean
  wtId?: string
  onGoProject: () => void
  onToggle: () => void
  onOpenWorktree: (worktree: Worktree) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const containsActiveWorktree = project.worktrees.some((worktree) => worktree.id === wtId)
  const expanded = project.expanded || containsActiveWorktree
  const machine = useMachines().data?.find((m) => m.id === project.machineId)
  const health = useMachineHealth(machine?.id)
  // Same "unreachable" definition as the Agents page: no machine assigned,
  // or the assigned machine is confirmed offline — either way navigating in
  // would just hang on a dead connection, so opening the project is blocked.
  const unreachable = !machine || health.data?.status === 'offline'
  const unreachableReason = machine ? `${machine.name} is offline — can't connect.` : 'No machine assigned to this project — can’t connect.'

  return (
    <div>
      <div
        className={cn(
          'group relative flex h-10 items-center rounded-[10px] transition-colors',
          selected || containsActiveWorktree
            ? 'bg-devdeck-hover-wash text-devdeck-fg'
            : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          className="ml-1 flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-surface-2 hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight size={14} className={cn('transition-transform', expanded && 'rotate-90')} />
        </button>
        <Tooltip label={unreachable ? unreachableReason : project.name}>
          <button
            type="button"
            aria-disabled={unreachable}
            aria-current={selected ? 'page' : undefined}
            onClick={() => !unreachable && onGoProject()}
            className={cn(
              'flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[10px] pr-14 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              unreachable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            <Folder size={17} strokeWidth={2.1} className="flex-none" style={{ color }} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{project.name}</span>
            <ProjectSyncBadge project={project} />
            {unreachable ? (
              <StatusDot color="#f87171" size={7} />
            ) : (
              <span className="font-mono text-[11.5px] font-semibold text-devdeck-dim transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                {project.worktrees.length}
              </span>
            )}
          </button>
        </Tooltip>
        <div className="pointer-events-none absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <button
            type="button"
            title={`Edit project ${project.name}`}
            aria-label={`Edit project ${project.name}`}
            onClick={onEdit}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-accent-tint hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            title={`Delete project ${project.name}`}
            aria-label={`Delete project ${project.name}`}
            onClick={onDelete}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-devdeck-border-menu pl-2">
          {project.worktrees.length === 0 ? (
            <div className="px-2 py-1.5 font-mono text-[10.5px] text-devdeck-dim">no terminals yet</div>
          ) : (
            project.worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.id}
                project={project}
                worktree={worktree}
                active={worktree.id === wtId}
                unreachable={unreachable}
                unreachableReason={unreachableReason}
                onOpen={() => onOpenWorktree(worktree)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function WorktreeRow({
  project,
  worktree,
  active,
  unreachable,
  unreachableReason,
  onOpen,
}: {
  project: Project
  worktree: Worktree
  active: boolean
  unreachable: boolean
  unreachableReason: string
  onOpen: () => void
}) {
  const state = STATE[worktree.state]
  const label = worktreeLabel(project, worktree)

  return (
    <Tooltip label={unreachable ? unreachableReason : label} side="right">
      <button
        type="button"
        onClick={() => !unreachable && onOpen()}
        aria-current={active ? 'page' : undefined}
        aria-disabled={unreachable}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          unreachable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          active ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
        )}
      >
        <StatusDot color={unreachable ? '#f87171' : state.color} size={6} />
        <WorktreeGlyph root={worktree.root} size={12} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
        <span className="font-mono text-[9.5px] text-devdeck-dim">{state.label}</span>
      </button>
    </Tooltip>
  )
}
