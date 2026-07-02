import { createFileRoute } from '@tanstack/react-router'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useWorkspace } from '@/features/data/queries'

export const Route = createFileRoute('/w/$wsId/p/$projectId/wt/$wtId')({
  component: TerminalRoute,
})

function TerminalRoute() {
  const { wsId, projectId, wtId } = Route.useParams()
  const worktree = useWorkspace(wsId)
    .data?.projects.find((p) => p.id === projectId)
    ?.worktrees.find((w) => w.id === wtId)

  if (!worktree) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-sm text-loom-dim">worktree not found</div>
    )
  }
  return <ExpandedTerminal worktree={worktree} wsId={wsId} projectId={projectId} />
}
