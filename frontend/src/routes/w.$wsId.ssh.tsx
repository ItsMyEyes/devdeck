import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/w/$wsId/ssh')({
  component: () => <Outlet />,
})
