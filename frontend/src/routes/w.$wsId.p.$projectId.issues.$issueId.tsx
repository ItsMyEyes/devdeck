import { createFileRoute } from '@tanstack/react-router'
import { IssueDetail } from '@/features/issues/IssueDetail'
import { useWorkspace } from '@/features/data/queries'
import { EmptyState } from '@/features/screens/EmptyState'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues/$issueId')({
  component: IssueDetailRoute,
})

function IssueDetailRoute() {
  const { wsId, projectId, issueId } = Route.useParams()
  const project = useWorkspace(wsId).data?.projects.find((p) => p.id === projectId)
  const issue = project?.issues.find((i) => i.id === issueId)
  if (!issue) return <EmptyState title="Issue not found" hint="It may have been deleted." />
  return <IssueDetail issue={issue} wsId={wsId} projectId={projectId} />
}
