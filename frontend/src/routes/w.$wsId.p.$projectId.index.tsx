import { createFileRoute } from '@tanstack/react-router'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { useWorkspace } from '@/features/data/queries'

export const Route = createFileRoute('/w/$wsId/p/$projectId/')({
  component: CardsRoute,
})

function CardsRoute() {
  const { wsId, projectId } = Route.useParams()
  // Loading / error are handled by the workspace layout; here data is present.
  const project = useWorkspace(wsId).data?.projects.find((p) => p.id === projectId)
  if (!project) return null
  return <WorktreeCardsGrid project={project} wsId={wsId} />
}
