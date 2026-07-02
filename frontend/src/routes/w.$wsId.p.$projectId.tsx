import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { AgentsBreadcrumb } from '@/features/agents/AgentsBreadcrumb'

export const Route = createFileRoute('/w/$wsId/p/$projectId')({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient
    let workspaces
    try {
      workspaces = await qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
    } catch {
      return // backend down — parent layout renders the error state
    }
    const ws = workspaces.find((w) => w.id === params.wsId)
    if (ws && !ws.projects.some((p) => p.id === params.projectId)) {
      throw redirect({ to: '/w/$wsId', params: { wsId: params.wsId } })
    }
  },
  component: ProjectLayout,
})

function ProjectLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentsBreadcrumb />
      <Outlet />
    </div>
  )
}
