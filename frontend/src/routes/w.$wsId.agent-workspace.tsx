import { lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useWorkspace } from '@/features/data/queries'

const AgentWorkspace = lazy(() =>
  import('@/features/agent-workspace/AgentWorkspace').then((m) => ({
    default: m.AgentWorkspace,
  })),
)
export const Route = createFileRoute('/w/$wsId/agent-workspace')({
  component: OfficeRoute,
})
function OfficeRoute() {
  const { wsId } = Route.useParams()
  const query = useWorkspace(wsId)
  if (query.isPending)
    return <p className="p-6 text-devdeck-fg-2">Loading workspace…</p>
  if (query.isError)
    return (
      <div role="alert" className="p-6">
        Could not load workspace.{' '}
        <button onClick={() => void query.refetch()}>Retry</button>
      </div>
    )
  if (!query.data) return <p className="p-6">Workspace not found.</p>
  return (
    <Suspense
      fallback={
        <p className="p-6 text-devdeck-fg-2">Opening Agent Workspace…</p>
      }
    >
      <AgentWorkspace key={wsId} workspace={query.data} />
    </Suspense>
  )
}
