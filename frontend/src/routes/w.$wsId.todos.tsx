import { createFileRoute } from '@tanstack/react-router'
import { TodosModule } from '@/features/modules/TodosModule'

export const Route = createFileRoute('/w/$wsId/todos')({
  component: TodosRoute,
})

function TodosRoute() {
  const { wsId } = Route.useParams()
  return <TodosModule wsId={wsId} />
}
