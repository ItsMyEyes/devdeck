import { useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, House, Kanban, Plus } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Project } from '@/store/types'
import { StatusDot } from '@/components/ui/status-dot'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import { useScope } from '@/features/useScope'
import { useSettings, useUpdateProject, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { useIsTauri } from '@/features/tabs/useIsTauri'

export function ProjectTree() {
  const { wsId } = useScope()
  const ws = useWorkspace(wsId).data
  const openNewProject = useLoomStore((s) => s.openNewProject)

  const projects = ws?.projects ?? []

  return (
    <>
      <div className="mt-1 flex h-[34px] flex-none items-center justify-between px-2.5 pl-4">
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-loom-dim">PROJECTS</span>
        <button
          onClick={openNewProject}
          title="New project"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-loom-border-strong text-loom-muted hover:bg-loom-popover hover:text-loom-fg"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-4 pt-1">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} wsId={wsId!} />
        ))}

        {projects.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 px-3 py-8 text-center font-mono text-[11.5px] text-loom-dim">
            <span>no projects in this workspace</span>
            <button
              onClick={openNewProject}
              className="h-7 cursor-pointer rounded-md border border-loom-border-menu bg-loom-elevated px-3 font-sans text-[11.5px] text-loom-fg-2 hover:bg-loom-hover-wash"
            >
              + Add project
            </button>
          </div>
        )}
      </div>
    </>
  )
}

function ProjectRow({ project: p, wsId }: { project: Project; wsId: string }) {
  const navigate = useNavigate()
  const { projectId, wtId } = useScope()
  const pathname = useLocation({ select: (l) => l.pathname })
  const updateProject = useUpdateProject()
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const openWorktreeTab = useLoomStore((s) => s.openWorktreeTab)
  const isTauri = useIsTauri()
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'

  const toggleExpanded = (id: string, expanded: boolean) => updateProject.mutate({ id, patch: { expanded } })
  const onIssues = projectId === p.id && pathname.includes('/issues')
  const selected = projectId === p.id && !wtId && !onIssues
  const running = p.worktrees.filter((w) => w.state === 'running').length
  const hasWait = p.worktrees.some((w) => w.state === 'waiting')
  const hasErr = p.worktrees.some((w) => w.state === 'error')
  const agg = hasErr ? '#f87171' : hasWait ? '#f5c451' : running > 0 ? '#56d58a' : '#5f6672'
  const aggLabel = hasErr ? 'error' : hasWait ? 'waiting' : running > 0 ? 'running' : 'idle'

  function selectProject() {
    if (!p.expanded) toggleExpanded(p.id, true)
    navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId: p.id } })
  }

  function openWorktree(wtId: string) {
    if (isTauri) openWorktreeTab(wsId, p.id, wtId)
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId: p.id, wtId } })
  }

  function onRowKeydown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      // Don't navigate if the event bubbled from a nested button.
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      selectProject()
    }
  }

  return (
    <div className="mb-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={selectProject}
        onKeyDown={onRowKeydown}
        className={cn(
          'flex min-h-9 cursor-pointer select-none items-center gap-[7px] rounded-lg px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          selected
            ? 'bg-loom-accent/10 shadow-[inset_2px_0_0_var(--loom-accent)]'
            : 'hover:bg-loom-hover-wash',
        )}
      >
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(p.id, !p.expanded)
          }}
          aria-label={p.expanded ? 'Collapse' : 'Expand'}
          aria-expanded={p.expanded}
          className="flex w-[13px] flex-none cursor-pointer justify-center text-loom-dim"
        >
          {p.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="h-[13px] w-[13px] flex-none rounded border-[1.5px] border-loom-dim-3" />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[12.5px] font-medium', selected ? 'text-loom-fg' : 'text-loom-fg-2')}>
            {p.name}
          </div>
          <div className="mt-px truncate font-mono text-[9.5px] text-loom-dim-2">{p.path}</div>
        </div>
        <StatusDot color={agg} />
        <span className="sr-only">{aggLabel}</span>
        <span className="flex-none font-mono text-[10.5px] text-loom-dim">{p.worktrees.length}</span>
      </div>

      {p.expanded && (
        <div className="ml-[11px] mt-px border-l border-loom-border pl-0.5">
          <div
            role="button"
            tabIndex={0}
            onClick={() => navigate({ to: '/w/$wsId/p/$projectId/issues', params: { wsId, projectId: p.id } })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate({ to: '/w/$wsId/p/$projectId/issues', params: { wsId, projectId: p.id } })
              }
            }}
            className={cn(
              'flex h-[29px] cursor-pointer select-none items-center gap-[7px] rounded-md px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              onIssues ? 'bg-loom-accent/10 shadow-[inset_2px_0_0_var(--loom-accent)]' : 'hover:bg-loom-hover-wash',
            )}
          >
            <Kanban size={12} className={cn('w-[11px] flex-none', onIssues ? 'text-loom-fg' : 'text-loom-dim')} />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-[11.5px]', onIssues ? 'text-loom-fg' : 'text-loom-muted')}>
              Issues
            </span>
            {p.issues.length > 0 && (
              <span className="flex-none font-mono text-[9.5px] text-loom-dim">{p.issues.length}</span>
            )}
          </div>

          {p.worktrees.map((w) => {
            const st = STATE[w.state]
            const wsel = wtId === w.id
            return (
              <div
                key={w.id}
                role="button"
                tabIndex={0}
                onClick={() => openWorktree(w.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openWorktree(w.id)
                  }
                }}
                className={cn(
                  'flex h-[29px] cursor-pointer select-none items-center gap-[7px] rounded-md px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  wsel
                    ? 'bg-loom-accent/10 shadow-[inset_2px_0_0_var(--loom-accent)]'
                    : 'hover:bg-loom-hover-wash',
                )}
              >
                <StatusDot color={st.color} />
                <WorktreeGlyph root={w.root} size={11} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono text-[11.5px]',
                    wsel ? 'text-loom-fg' : 'text-loom-muted',
                  )}
                >
                  {worktreeLabel(p, w)}
                </span>
                <span className="flex-none font-mono text-[9.5px]" style={{ color: st.color }}>
                  {st.label}
                </span>
              </div>
            )
          })}

          <button
            onClick={() => openSpawn(p.id, 'branch', defaultModel)}
            className="flex h-[26px] w-full cursor-pointer items-center gap-[7px] rounded-md px-2 pl-[9px] text-[11.5px] text-loom-dim hover:bg-loom-hover-wash hover:text-loom-muted"
          >
            <Plus size={13} className="w-[11px]" />
            new branch
          </button>
          <button
            onClick={() => openSpawn(p.id, 'root', defaultModel)}
            className="flex h-[26px] w-full cursor-pointer items-center gap-[7px] rounded-md px-2 pl-[9px] text-[11.5px] text-loom-dim hover:bg-loom-hover-wash hover:text-loom-purple"
          >
            <House size={12} className="w-[11px]" />
            root terminal
          </button>
        </div>
      )}
    </div>
  )
}
