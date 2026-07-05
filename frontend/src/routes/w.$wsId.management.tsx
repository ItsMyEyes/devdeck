import { createFileRoute } from '@tanstack/react-router'
import { AgentManagementModule } from '@/features/agent-management/AgentManagementModule'

export const Route = createFileRoute('/w/$wsId/management')({
  component: AgentManagementRoute,
})

function AgentManagementRoute() {
  return <AgentManagementModule />
}
