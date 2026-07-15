import { useMemo, useState } from 'react'
import { GitBranch, Grid2X2, House, List, Plus, Search, X } from 'lucide-react'
import type { Project } from '@/store/types'
import { cn } from '@/lib/utils'
import { useSettings } from '@/features/data/queries'
import { worktreeLabel } from '@/lib/worktreeLabel'
import { useLoomStore } from '@/store/useLoomStore'
import { WorktreeCard } from './WorktreeCard'
export function WorktreeCardsGrid({ project, wsId }: { project: Project; wsId: string }) {
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'cards' | 'list'>('cards')

  const branchCount = project.worktrees.filter((w) => !w.root).length
  const rootCount = project.worktrees.length - branchCount
  const activeCount = project.worktrees.filter((w) => w.state === 'running' || w.state === 'waiting').length
  const searchNeedle = query.trim().toLowerCase()
  const filteredWorktrees = useMemo(() => {
    if (!searchNeedle) return project.worktrees
    return project.worktrees.filter((w) => {
      const haystack = [
        worktreeLabel(project, w),
        w.branch,
        w.base,
        w.agent,
        w.model,
        w.state,
        w.task,
        w.root ? 'root project root terminal shell' : 'worktree branch agent',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(searchNeedle)
    })
  }, [project, searchNeedle])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="flex-none border-b border-loom-border bg-loom-bg px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-loom-fg-2">Agents</h2>
              <span className="rounded-full bg-loom-surface-2 px-2 py-0.5 font-mono text-[10px] text-loom-muted-2">
                {project.worktrees.length}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-loom-dim">
              <span>{activeCount} active</span>
              <span aria-hidden="true">·</span>
              <span>{branchCount} worktrees</span>
              <span aria-hidden="true">·</span>
              <span>{rootCount} root</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            <div className="relative min-w-0 sm:w-[280px] lg:w-[340px]">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-loom-dim" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
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
                <button
                  type="button"
                  aria-label="Show card view"
                  aria-pressed={view === 'cards'}
                  onClick={() => setView('cards')}
                  className={cn(
                    'flex h-7 w-8 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    view === 'cards' ? 'bg-loom-accent-tint text-loom-accent-soft' : 'text-loom-dim hover:text-loom-fg',
                  )}
                >
                  <Grid2X2 size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Show list view"
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                  className={cn(
                    'flex h-7 w-8 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    view === 'list' ? 'bg-loom-accent-tint text-loom-accent-soft' : 'text-loom-dim hover:text-loom-fg',
                  )}
                >
                  <List size={15} />
                </button>
              </div>

              <button
                type="button"
                onClick={() => openSpawn(project.id, 'root', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-loom-surface-2 px-3 text-[12px] font-semibold text-loom-muted transition-colors hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <House size={13} />
                <span className="hidden sm:inline">Root</span>
              </button>
              <button
                type="button"
                onClick={() => openSpawn(project.id, 'branch', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-loom-border-accent bg-loom-accent-tint px-3 text-[12px] font-semibold text-loom-accent-soft transition-colors hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <GitBranch size={13} />
                New worktree
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {filteredWorktrees.length === 0 ? (
          <div className="flex min-h-[220px] flex-col items-center justify-center rounded-[13px] border border-dashed border-loom-border-menu bg-loom-card/35 px-4 text-center">
            <div className="text-[13px] font-semibold text-loom-fg-2">
              {searchNeedle ? 'No agents match that search' : 'No agents yet'}
            </div>
            <div className="mt-2 text-[12px] text-loom-muted">
              {searchNeedle ? 'Try another branch, model, task, or state.' : 'Create a worktree agent or open a root terminal.'}
            </div>
            {searchNeedle ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-3 cursor-pointer text-[12px] text-loom-accent-soft hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Clear filter
              </button>
            ) : (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => openSpawn(project.id, 'root', defaultModel)}
                  className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-loom-surface-2 px-3 text-[12px] font-semibold text-loom-muted hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <House size={13} />
                  Root terminal
                </button>
                <button
                  type="button"
                  onClick={() => openSpawn(project.id, 'branch', defaultModel)}
                  className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-loom-border-accent bg-loom-accent-tint px-3 text-[12px] font-semibold text-loom-accent-soft hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <GitBranch size={13} />
                  New worktree
                </button>
              </div>
            )}
          </div>
        ) : view === 'cards' ? (
          <div
            className="grid content-start gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}
          >
            {filteredWorktrees.map((w) => (
              <WorktreeCard key={w.id} worktree={w} wsId={wsId} projectId={project.id} />
            ))}

            <button
              onClick={() => openSpawn(project.id, 'branch', defaultModel)}
              className="flex min-h-[218px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[13px] border border-dashed border-loom-border-menu bg-loom-card/35 font-mono text-[12px] text-loom-dim transition-colors hover:border-loom-border-accent hover:bg-loom-card/60 hover:text-loom-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Plus size={26} strokeWidth={1.5} />
              <span>new worktree</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredWorktrees.map((w) => (
              <WorktreeCard key={w.id} worktree={w} wsId={wsId} projectId={project.id} variant="list" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
