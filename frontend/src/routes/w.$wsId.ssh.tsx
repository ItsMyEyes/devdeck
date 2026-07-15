import { createFileRoute } from '@tanstack/react-router'
import { SSHConnectionsModule } from '@/features/ssh/SSHConnectionsModule'

export const Route = createFileRoute('/w/$wsId/ssh')({
  component: SSHRoute,
})

function SSHRoute() {
  return <SSHConnectionsModule />
}
