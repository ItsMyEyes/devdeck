import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { meQueryOptions } from '@/features/data/authQueries'
import { useViewportHeight } from '@/features/useViewportHeight'

export interface RouterContext {
  queryClient: QueryClient
}

const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied'])

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: RootComponent,
})

function RootComponent() {
  useViewportHeight()
  return (
    <>
      <Outlet />
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--devdeck-elevated)',
            border: '1px solid var(--devdeck-border-accent)',
            color: 'var(--devdeck-fg-2)',
            fontSize: '12.5px',
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </>
  )
}
