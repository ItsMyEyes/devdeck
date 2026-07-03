import { createFileRoute } from '@tanstack/react-router'
import { ToolsModule } from '@/features/modules/ToolsModule'

export const Route = createFileRoute('/w/$wsId/tools')({
  component: ToolsRoute,
})

function ToolsRoute() {
  return <ToolsModule />
}
