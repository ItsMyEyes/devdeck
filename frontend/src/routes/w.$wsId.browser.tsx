import { createFileRoute } from '@tanstack/react-router'
import { BrowserModule } from '@/features/modules/BrowserModule'

export const Route = createFileRoute('/w/$wsId/browser')({
  component: BrowserRoute,
})

function BrowserRoute() {
  return <BrowserModule />
}
