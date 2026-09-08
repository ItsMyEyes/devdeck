import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { GitBranch, Grid2X2, List, Plus, RefreshCw, Search, Server, Settings, Settings2, Trash2, X } from 'lucide-react'
import { StatusDot } from '@/components/ui/status-dot'
import { Tooltip } from '@/components/ui/tooltip'
import { useMachineHealth, useMachines, useRefreshAgents, useSettings } from '@/features/data/queries'
import { tourAnchor } from '@/features/tour/tourAnchors'
import { cn } from '@/lib/utils'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Project, Worktree } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { WorktreeCard } from './WorktreeCard'

interface WorkspaceHostsViewProps {
  wsId: string
  projects: Project[]
  selectedProjectId?: string
}

interface ProjectGroup {
  project: Project
  worktrees: Worktree[]
}

export function WorkspaceHostsView({ wsId, projects, selectedProjectId }: WorkspaceHostsViewProps) {
  const navigate = useNavigate()
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const openSpawn = useDevDeckStore((s) => s.openSpawn)
  const openNewProject = useDevDeckStore((s) => s.openNewProject)
  const refreshAgents = useRefreshAgents()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'cards' | 'list'>('cards')
  const [refreshing, setRefreshing] = useState(false)

  const selectedProject = selectedProjectId ? projects.find((project) => project.id === selectedProjectId) : undefined
  const spawnProjectId = selectedProject?.id ?? null
  const searchNeedle = query.trim().toLowerCase()
  const allWorktrees = projects.flatMap((project) => project.worktrees)
  const branchCount = allWorktrees.filter((worktree) => !worktree.root).length
  const rootCount = allWorktrees.length - branchCount
  const activeCount = allWorktrees.filter((worktree) => worktree.state === 'running' || worktree.state === 'waiting').length

  const groups = useMemo<ProjectGroup[]>(() => {
    return projects
      .map((project) => {
        const projectHaystack = [project.name, project.repo, project.path].filter(Boolean).join(' ').toLowerCase()
        const projectMatches = Boolean(searchNeedle && projectHaystack.includes(searchNeedle))
        const worktrees = projectMatches
          ? project.worktrees
          : project.worktrees.filter((worktree) => matchesWorktree(project, worktree, searchNeedle))
        return { project, worktrees }
      })
      .filter((group) => !searchNeedle || group.worktrees.length > 0)
  }, [projects, searchNeedle])

  const hasProjects = projects.length > 0
  const hasMatches = groups.some((group) => group.worktrees.length > 0) || (!searchNeedle && groups.length > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="flex-none border-b border-devdeck-border bg-devdeck-pane px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div {...tourAnchor('agents-heading')} className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-devdeck-fg">Agents</h1>
              <span className="rounded-full bg-devdeck-card-wash px-2 py-0.5 font-mono text-[10px] text-devdeck-fg-2">
                {allWorktrees.length}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-devdeck-fg-2">
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
            <div {...tourAnchor('agents-search')} className="relative min-w-0 sm:w-[280px] lg:w-[340px]">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-devdeck-fg-2" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter agents, branches, tasks…"
                className="h-9 w-full rounded-control border border-devdeck-border-card bg-devdeck-pane px-8 text-[12px] text-devdeck-fg placeholder:text-devdeck-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear agent search"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <div
                {...tourAnchor('agents-view-toggle')}
                className="grid h-9 grid-cols-2 rounded-control border border-devdeck-border-card bg-devdeck-pane p-1"
                role="group"
                aria-label="Agent layout"
              >
                <ViewButton label="Show card view" active={view === 'cards'} onClick={() => setView('cards')}>
                  <Grid2X2 size={14} />
                </ViewButton>
                <ViewButton label="Show list view" active={view === 'list'} onClick={() => setView('list')}>
                  <List size={15} />
                </ViewButton>
              </div>

              <button
                {...tourAnchor('agents-refresh')}
                type="button"
                disabled={refreshing}
                aria-label="Refresh agents"
                title="Refresh agents"
                onClick={() => {
                  setRefreshing(true)
                  void refreshAgents().finally(() => setRefreshing(false))
                }}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-control bg-devdeck-card-wash px-3 text-[12px] font-semibold text-devdeck-fg-2 transition-colors hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <button
                {...tourAnchor('agents-new')}
                type="button"
                disabled={!hasProjects}
                onClick={() => openSpawn(spawnProjectId, 'branch', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-devdeck-border-accent bg-devdeck-accent-tint px-3 text-[12px] font-semibold text-devdeck-accent transition-colors hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <GitBranch size={13} />
                New agent
              </button>
              <button
                {...tourAnchor('agents-management')}
                type="button"
                onClick={() => navigate({ to: '/w/$wsId/management', params: { wsId } })}
                aria-label="Agent management"
                title="Agent management"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-control bg-devdeck-card-wash text-devdeck-fg-2 transition-colors hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {/* Gear, matching the management module's own tab icon
                    (MODULE_ICON.management) — Settings2's sliders are this
                    view's project-edit affordance below. */}
                <Settings size={14} />
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
  const openEdit = useDevDeckStore((s) => s.openEdit)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const openSpawn = useDevDeckStore((s) => s.openSpawn)
  const { project, worktrees } = group
  const machine = useMachines().data?.find((m) => m.id === project.machineId)
  const health = useMachineHealth(machine?.id)
  // Unreachable covers both "machine offline" and "machine was deleted out
  // from under this project" (see ConfirmDeleteDialog's "projects still
  // pointing at it show as unreachable" copy) — either way there's nothing
  // to connect to, so new-agent affordances are disabled the same way.
  const unreachable = !machine || health.data?.status === 'offline'
  const unreachableReason = machine ? `${machine.name} is offline - can't connect.` : 'No machine assigned to this project - can’t connect.'

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="truncate text-[18px] font-semibold leading-none text-devdeck-fg">{project.name}</h2>
        <span className="rounded-full bg-devdeck-card-wash px-2 py-0.5 font-mono text-[10px] text-devdeck-fg-2">
          {project.worktrees.length}
        </span>
        <span aria-hidden="true" className="font-mono text-[11px] text-devdeck-fg-2/50">/</span>
        <span className="truncate font-mono text-[11px] text-devdeck-fg-2">{project.path}</span>
        <span aria-hidden="true" className="font-mono text-[11px] text-devdeck-fg-2/50">~</span>
        {machine ? (
          <span
            className={cn(
              'flex flex-none items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]',
              unreachable ? 'bg-devdeck-red-tint text-devdeck-err' : 'bg-devdeck-card-wash text-devdeck-fg-2',
            )}
          >
            {unreachable ? <StatusDot color="var(--devdeck-err)" size={6} /> : <Server size={10} />}
            {machine.name}
            {unreachable ? ' · offline' : ''}
          </span>
        ) : (
          <span className="flex flex-none items-center gap-1 rounded-full bg-devdeck-red-tint px-2 py-0.5 font-mono text-[10px] text-devdeck-err">
            <StatusDot color="var(--devdeck-err)" size={6} />
            no machine
          </span>
        )}
        <div className="h-px min-w-6 flex-1 bg-devdeck-border" />
        <button
          type="button"
          aria-label={`Edit ${project.name}`}
          onClick={() => openEdit('project', project.id, { a: project.name, b: project.path })}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Settings2 size={13} />
        </button>
        <button
          type="button"
          aria-label={`Delete ${project.name}`}
          onClick={() => askDelete('project', project.id, project.name)}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-red-tint hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {worktrees.length === 0 ? (
        <NewAgentTile
          projectName={project.name}
          unreachable={unreachable}
          unreachableReason={unreachableReason}
          onSpawn={() => openSpawn(project.id, 'branch', defaultModel)}
        />
      ) : view === 'cards' ? (
        <div className="grid content-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}>
          {worktrees.map((worktree) => (
            <WorktreeCard key={worktree.id} worktree={worktree} wsId={wsId} projectId={project.id} />
          ))}
          <NewAgentTile
            projectName={project.name}
            unreachable={unreachable}
            unreachableReason={unreachableReason}
            onSpawn={() => openSpawn(project.id, 'branch', defaultModel)}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {worktrees.map((worktree) => (
            <WorktreeCard key={worktree.id} worktree={worktree} wsId={wsId} projectId={project.id} variant="list" />
          ))}
          <NewAgentTile
            projectName={project.name}
            unreachable={unreachable}
            unreachableReason={unreachableReason}
            onSpawn={() => openSpawn(project.id, 'branch', defaultModel)}
            variant="row"
          />
        </div>
      )}
    </section>
  )
}

/** Dashed "new agent in <project>" affordance. Rendered in every project group
 *  — on its own when the group is empty, and as the trailing grid/list item
 *  when the group already has agents — so starting one never depends on
 *  reaching for the toolbar. */
function NewAgentTile({
  projectName,
  unreachable,
  unreachableReason,
  onSpawn,
  variant = 'tile',
}: {
  projectName: string
  unreachable: boolean
  unreachableReason: string
  onSpawn: () => void
  variant?: 'tile' | 'row'
}) {
  return (
    <Tooltip label={unreachable ? unreachableReason : `New agent in ${projectName}`}>
      <button
        type="button"
        aria-disabled={unreachable}
        onClick={() => !unreachable && onSpawn()}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-control border border-dashed font-mono text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          variant === 'row' ? 'min-h-[56px] px-3 py-2.5' : 'h-full min-h-[104px] flex-col',
          unreachable
            ? 'cursor-not-allowed border-devdeck-border-menu bg-devdeck-glass-solid/15 text-devdeck-fg-2/50'
            : 'cursor-pointer border-devdeck-border-menu bg-devdeck-glass-solid/35 text-devdeck-fg-2 hover:border-devdeck-border-accent hover:bg-devdeck-glass-solid/60 hover:text-devdeck-fg-2',
        )}
      >
        <Plus size={variant === 'row' ? 15 : 22} strokeWidth={1.5} />
        <span className="truncate">new agent in {projectName}</span>
      </button>
    </Tooltip>
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
        active ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg',
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
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-control border border-dashed border-devdeck-border-menu bg-devdeck-glass-solid/35 px-4 text-center">
      <div className="text-[13px] font-semibold text-devdeck-fg">{title}</div>
      <div className="mt-2 max-w-[42ch] text-[12px] leading-relaxed text-devdeck-fg-2">{hint}</div>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 cursor-pointer rounded-md border border-devdeck-border-accent bg-devdeck-accent-tint px-3 py-1.5 text-[12px] font-semibold text-devdeck-accent hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
