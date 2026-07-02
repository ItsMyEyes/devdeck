import { createFileRoute } from '@tanstack/react-router'
import { NewsModule } from '@/features/modules/NewsModule'

export const Route = createFileRoute('/w/$wsId/news')({
  component: NewsRoute,
})

function NewsRoute() {
  const { wsId } = Route.useParams()
  return <NewsModule wsId={wsId} />
}
