import { createFileRoute } from '@tanstack/react-router'
import { MemoryModule } from '@/features/memory/MemoryModule'

export const Route = createFileRoute('/w/$wsId/memory')({
  component: MemoryRoute,
})

function MemoryRoute() {
  return <MemoryModule />
}
