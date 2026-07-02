import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues')({
  component: () => <Outlet />,
})
