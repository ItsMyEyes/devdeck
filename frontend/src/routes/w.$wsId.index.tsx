import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceHostsView } from '@/features/agents/WorkspaceHostsView'
import { useWorkspace } from '@/features/data/queries'

export const Route = createFileRoute('/w/$wsId/')({
  component: HostsRoute,
})

function HostsRoute() {
  const { wsId } = Route.useParams()
  const workspace = useWorkspace(wsId).data
  if (!workspace) return null
  return <WorkspaceHostsView wsId={wsId} projects={workspace.projects} />
}
