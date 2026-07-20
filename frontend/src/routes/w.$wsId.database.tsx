import { createFileRoute } from '@tanstack/react-router'
import { DatabaseModule } from '@/features/database/DatabaseModule'

export const Route = createFileRoute('/w/$wsId/database')({
  component: DatabaseRoute,
})

function DatabaseRoute() {
  return <DatabaseModule />
}
