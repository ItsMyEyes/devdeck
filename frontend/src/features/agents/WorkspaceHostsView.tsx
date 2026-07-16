import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { GitBranch, Grid2X2, House, List, Plus, Search, Server, Settings2, Trash2, X } from 'lucide-react'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip } from '@/components/ui/tooltip'
import { useMachineHealth, useMachines, useSettings } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Project, Worktree } from '@/store/types'
import { useLoomStore } from '@/store/useLoomStore'
import { WorktreeCard } from './WorktreeCard'

interface WorkspaceHostsViewProps {
  wsId: string
  projects: Project[]
  selectedProjectId?: string
}

interface ProjectGroup {
  project: Project
  worktrees: Worktree[]
  color: string
}

const GROUP_COLORS = ['#ff6978', '#4aa8ff', '#a578ff', '#5ed69a', '#f5c451', '#c7a3ff']

export function WorkspaceHostsView({ wsId, projects, selectedProjectId }: WorkspaceHostsViewProps) {
  const navigate = useNavigate()
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const openNewProject = useLoomStore((s) => s.openNewProject)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'cards' | 'list'>('cards')

  const selectedProject = selectedProjectId ? projects.find((project) => project.id === selectedProjectId) : undefined
  const scopedProjects = selectedProject ? [selectedProject] : projects
  const spawnProjectId = selectedProject?.id ?? null
  const searchNeedle = query.trim().toLowerCase()
  const allWorktrees = scopedProjects.flatMap((project) => project.worktrees)
  const branchCount = allWorktrees.filter((worktree) => !worktree.root).length
  const rootCount = allWorktrees.length - branchCount
  const activeCount = allWorktrees.filter((worktree) => worktree.state === 'running' || worktree.state === 'waiting').length

  const groups = useMemo<ProjectGroup[]>(() => {
    return scopedProjects
      .map((project, index) => {
        const projectHaystack = [project.name, project.repo, project.path].filter(Boolean).join(' ').toLowerCase()
        const projectMatches = Boolean(searchNeedle && projectHaystack.includes(searchNeedle))
        const worktrees = projectMatches
          ? project.worktrees
          : project.worktrees.filter((worktree) => matchesWorktree(project, worktree, searchNeedle))
        return { project, worktrees, color: GROUP_COLORS[index % GROUP_COLORS.length] }
      })
      .filter((group) => !searchNeedle || group.worktrees.length > 0)
  }, [scopedProjects, searchNeedle])

  const hasProjects = projects.length > 0
  const hasMatches = groups.some((group) => group.worktrees.length > 0) || (!searchNeedle && groups.length > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="flex-none border-b border-loom-border bg-loom-bg px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-loom-fg-2">Agents</h1>
              <span className="rounded-full bg-loom-surface-2 px-2 py-0.5 font-mono text-[10px] text-loom-muted-2">
                {allWorktrees.length}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-loom-dim">
              <span>{activeCount} active</span>
              <span aria-hidden="true">·</span>
              <span>{branchCount} worktrees</span>
              <span aria-hidden="true">·</span>
              <span>{rootCount} root</span>
              {selectedProject ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{selectedProject.name}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            <div className="relative min-w-0 sm:w-[280px] lg:w-[340px]">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-loom-dim" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter agents, branches, tasks…"
                className="h-9 w-full rounded-[10px] border border-loom-border-card bg-loom-surface px-8 text-[12px] text-loom-fg placeholder:text-loom-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear agent search"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <div className="grid h-9 grid-cols-2 rounded-[10px] border border-loom-border-card bg-loom-surface p-1" role="group" aria-label="Agent layout">
                <ViewButton label="Show card view" active={view === 'cards'} onClick={() => setView('cards')}>
                  <Grid2X2 size={14} />
                </ViewButton>
                <ViewButton label="Show list view" active={view === 'list'} onClick={() => setView('list')}>
                  <List size={15} />
                </ViewButton>
              </div>

              <button
                type="button"
                disabled={!hasProjects}
                onClick={() => openSpawn(spawnProjectId, 'root', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-loom-surface-2 px-3 text-[12px] font-semibold text-loom-muted transition-colors hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <House size={13} />
                <span className="hidden sm:inline">Root</span>
              </button>
              <button
                type="button"
                disabled={!hasProjects}
                onClick={() => openSpawn(spawnProjectId, 'branch', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-loom-border-accent bg-loom-accent-tint px-3 text-[12px] font-semibold text-loom-accent-soft transition-colors hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <GitBranch size={13} />
                New agent
              </button>
              <button
                type="button"
                onClick={() => navigate({ to: '/w/$wsId/management', params: { wsId } })}
                aria-label="Agent management"
                title="Agent management"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] bg-loom-surface-2 text-loom-muted transition-colors hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Settings2 size={14} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {!hasProjects ? (
          <EmptyHostsState
            title="No projects in this workspace"
            hint="Create a project first, then start worktree agents or root terminals from its group."
            actionLabel="+ Add project"
            onAction={openNewProject}
          />
        ) : !hasMatches ? (
          <EmptyHostsState
            title={searchNeedle ? 'No agents match that search' : 'No agents yet'}
            hint={searchNeedle ? 'Try another project, branch, model, task, or state.' : 'Create a worktree agent or open a root terminal.'}
            actionLabel={searchNeedle ? 'Clear filter' : 'New agent'}
            onAction={searchNeedle ? () => setQuery('') : () => openSpawn(spawnProjectId, 'branch', defaultModel)}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <ProjectHostSection
                key={group.project.id}
                group={group}
                wsId={wsId}
                view={view}
                defaultModel={defaultModel}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectHostSection({
  group,
  wsId,
  view,
  defaultModel,
}: {
  group: ProjectGroup
  wsId: string
  view: 'cards' | 'list'
  defaultModel: string
}) {
  const openEdit = useLoomStore((s) => s.openEdit)
  const askDelete = useLoomStore((s) => s.askDelete)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const { project, worktrees, color } = group
  const machine = useMachines().data?.find((m) => m.id === project.machineId)
  const health = useMachineHealth(machine?.id)
  // Unreachable covers both "machine offline" and "machine was deleted out
  // from under this project" (see ConfirmDeleteDialog's "projects still
  // pointing at it show as unreachable" copy) — either way there's nothing
  // to connect to, so new-agent affordances are disabled the same way.
  const unreachable = !machine || health.data?.status === 'offline'
  const unreachableReason = machine ? `${machine.name} is offline — can't connect.` : 'No machine assigned to this project — can’t connect.'

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-3">
        <span className="h-[11px] w-[11px] flex-none rounded-[2px] border" style={{ borderColor: color, background: `${color}18` }} />
        <h2 className="truncate text-[18px] font-semibold leading-none text-loom-fg-2">{project.name}</h2>
        <span className="rounded-full bg-loom-surface-2 px-2 py-0.5 font-mono text-[10px] text-loom-dim">
          {project.worktrees.length}
        </span>
        <span aria-hidden="true" className="font-mono text-[11px] text-loom-dim/50">/</span>
        <span className="truncate font-mono text-[11px] text-loom-dim">{project.path}</span>
        <span aria-hidden="true" className="font-mono text-[11px] text-loom-dim/50">~</span>
        {machine ? (
          <span
            className={cn(
              'flex flex-none items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]',
              unreachable ? 'bg-loom-red-tint text-loom-red-soft' : 'bg-loom-surface-2 text-loom-dim',
            )}
          >
            {unreachable ? <StatusDot color="#f87171" size={6} /> : <Server size={10} />}
            {machine.name}
            {unreachable ? ' · offline' : ''}
          </span>
        ) : (
          <span className="flex flex-none items-center gap-1 rounded-full bg-loom-red-tint px-2 py-0.5 font-mono text-[10px] text-loom-red-soft">
            <StatusDot color="#f87171" size={6} />
            no machine
          </span>
        )}
        <div className="h-px min-w-6 flex-1 bg-loom-border" />
        <button
          type="button"
          aria-label={`Edit ${project.name}`}
          onClick={() => openEdit('project', project.id, { a: project.name, b: project.path })}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-hover-wash hover:text-loom-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Settings2 size={13} />
        </button>
        <button
          type="button"
          aria-label={`Delete ${project.name}`}
          onClick={() => askDelete('project', project.id, project.name)}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-red-tint hover:text-loom-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {worktrees.length === 0 ? (
        <Tooltip label={unreachable ? unreachableReason : `New agent in ${project.name}`}>
          <button
            type="button"
            aria-disabled={unreachable}
            onClick={() => !unreachable && openSpawn(project.id, 'branch', defaultModel)}
            className={cn(
              'flex min-h-[104px] w-full flex-col items-center justify-center gap-2 rounded-[13px] border border-dashed font-mono text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              unreachable
                ? 'cursor-not-allowed border-loom-border-menu bg-loom-card/15 text-loom-dim/50'
                : 'cursor-pointer border-loom-border-menu bg-loom-card/35 text-loom-dim hover:border-loom-border-accent hover:bg-loom-card/60 hover:text-loom-muted',
            )}
          >
            <Plus size={22} strokeWidth={1.5} />
            <span>new agent in {project.name}</span>
          </button>
        </Tooltip>
      ) : view === 'cards' ? (
        <div className="grid content-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}>
          {worktrees.map((worktree) => (
            <WorktreeCard key={worktree.id} worktree={worktree} wsId={wsId} projectId={project.id} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {worktrees.map((worktree) => (
            <WorktreeCard key={worktree.id} worktree={worktree} wsId={wsId} projectId={project.id} variant="list" />
          ))}
        </div>
      )}
    </section>
  )
}

function ViewButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-7 w-8 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'bg-loom-accent-tint text-loom-accent-soft' : 'text-loom-dim hover:text-loom-fg',
      )}
    >
      {children}
    </button>
  )
}

function EmptyHostsState({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string
  hint: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-[13px] border border-dashed border-loom-border-menu bg-loom-card/35 px-4 text-center">
      <div className="text-[13px] font-semibold text-loom-fg-2">{title}</div>
      <div className="mt-2 max-w-[42ch] text-[12px] leading-relaxed text-loom-muted">{hint}</div>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 cursor-pointer rounded-md border border-loom-border-accent bg-loom-accent-tint px-3 py-1.5 text-[12px] font-semibold text-loom-accent-soft hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {actionLabel}
      </button>
    </div>
  )
}

function matchesWorktree(project: Project, worktree: Worktree, searchNeedle: string) {
  if (!searchNeedle) return true
  const haystack = [
    project.name,
    project.repo,
    project.path,
    worktreeLabel(project, worktree),
    worktree.branch,
    worktree.base,
    worktree.agent,
    worktree.model,
    worktree.state,
    worktree.task,
    worktree.root ? 'root project root terminal shell' : 'worktree branch agent host',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(searchNeedle)
}
