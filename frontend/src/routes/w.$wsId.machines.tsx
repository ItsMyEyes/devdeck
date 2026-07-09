import { createFileRoute } from '@tanstack/react-router'
import { MachinesModule } from '@/features/machines/MachinesModule'

export const Route = createFileRoute('/w/$wsId/machines')({
  component: MachinesRoute,
})

function MachinesRoute() {
  return <MachinesModule />
}
