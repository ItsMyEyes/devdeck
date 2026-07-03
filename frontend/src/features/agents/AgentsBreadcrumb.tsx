import { useNavigate } from '@tanstack/react-router'
import { Code2, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WorktreeGlyph } from './WorktreeGlyph'
import { useScope } from '@/features/useScope'
import { useStartProjectCodeServer, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

export function AgentsBreadcrumb() {
  const navigate = useNavigate()
  const { wsId, projectId, wtId } = useScope()
  const ws = useWorkspace(wsId).data
  const toggleWsMenu = useLoomStore((s) => s.toggleWsMenu)
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const openEdit = useLoomStore((s) => s.openEdit)
  const startCodeServer = useStartProjectCodeServer()

  const project = ws?.projects.find((p) => p.id === projectId) ?? null
  const worktree = project?.worktrees.find((w) => w.id === wtId) ?? null

  function openCode() {
    if (!project) return
    startCodeServer.mutate(project.id, {
      onSuccess: (data) => window.open(data.url, '_blank', 'noopener,noreferrer'),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start code-server'),
    })
  }

  function openWorkspaceMenu() {
    // On mobile the popover anchor is inside the off-screen sidebar, so we must
    // slide the sidebar into view first.
    setSidebarOpen(true)
    toggleWsMenu()
  }

  return (
    <div className="flex min-h-12 flex-none flex-wrap items-center gap-x-[9px] gap-y-1.5 border-b border-loom-border px-4 py-2.5">
      <button
        type="button"
        onClick={openWorkspaceMenu}
        className="cursor-pointer whitespace-nowrap font-mono text-[11.5px] text-loom-muted-2 hover:text-loom-fg-2"
      >
        {ws?.name ?? '—'}
      </button>
      <span className="text-loom-dim-3">/</span>
      <button
        type="button"
        onClick={() => project && wsId && navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId: project.id } })}
        className="cursor-pointer whitespace-nowrap text-[13px] font-semibold text-loom-fg-2"
      >
        {project?.name ?? '—'}
      </button>
      {project && <span className="whitespace-nowrap font-mono text-[11px] text-loom-dim-2">{project.path}</span>}

      {worktree ? (
        <>
          <span className="text-loom-dim-3">/</span>
          <WorktreeGlyph root={worktree.root} size={12} />
          <span className="max-w-[200px] truncate whitespace-nowrap font-mono text-[12px] text-loom-fg-2">
            {worktree.root ? 'project root' : worktree.branch}
          </span>
        </>
      ) : (
        project && (
          <span className="whitespace-nowrap font-mono text-[11px] text-loom-dim">
            · {project.worktrees.length} worktrees
          </span>
        )
      )}

      <div className="min-w-2 flex-1" />

      {project && (
        <Button variant="secondary" size="sm" onClick={openCode} disabled={startCodeServer.isPending}>
          <Code2 size={13} />
          {startCodeServer.isPending ? 'opening…' : 'Open code'}
        </Button>
      )}

      {project && !worktree && (
        <Button variant="secondary" size="sm" onClick={() => openEdit('project', project.id, { a: project.name, b: project.path })}>
          <Settings2 size={13} />
          Project settings
        </Button>
      )}
    </div>
  )
}
