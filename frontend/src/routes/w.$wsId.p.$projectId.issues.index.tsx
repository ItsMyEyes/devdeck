import { createFileRoute } from '@tanstack/react-router'
import { IssuesBoard } from '@/features/issues/IssuesBoard'
import { useWorkspace } from '@/features/data/queries'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues/')({
  component: IssuesRoute,
})

function IssuesRoute() {
  const { wsId, projectId } = Route.useParams()
  const project = useWorkspace(wsId).data?.projects.find((p) => p.id === projectId)
  if (!project) return null
  return <IssuesBoard project={project} wsId={wsId} />
}
