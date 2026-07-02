import { createFileRoute } from '@tanstack/react-router'
import { InvoicesModule } from '@/features/modules/InvoicesModule'

export const Route = createFileRoute('/w/$wsId/invoices')({
  component: InvoicesRoute,
})

function InvoicesRoute() {
  const { wsId } = Route.useParams()
  return <InvoicesModule wsId={wsId} />
}
