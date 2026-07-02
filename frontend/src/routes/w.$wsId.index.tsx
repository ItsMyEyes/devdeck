import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { AgentsEmpty } from '@/features/screens/AgentsEmpty'

export const Route = createFileRoute('/w/$wsId/')({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient
    let workspaces
    try {
      workspaces = await qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
    } catch {
      return // backend down — parent layout renders the error state
    }
    const ws = workspaces.find((w) => w.id === params.wsId)
    const first = ws?.projects[0]
    if (first) {
      throw redirect({ to: '/w/$wsId/p/$projectId', params: { wsId: params.wsId, projectId: first.id } })
    }
  },
  component: AgentsEmpty,
})
