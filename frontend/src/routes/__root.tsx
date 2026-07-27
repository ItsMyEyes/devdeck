import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { meQueryOptions } from '@/features/data/authQueries'
import { qk } from '@/features/data/keys'
import { fetchWhoami } from '@/lib/api'
import { useViewportHeight } from '@/features/useViewportHeight'

export interface RouterContext {
  queryClient: QueryClient
}

const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied', '/handover', '/runtime-sign-in'])

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      const whoami = await context.queryClient
        .fetchQuery({ queryKey: qk.whoami, queryFn: fetchWhoami })
        .catch(() => null)
      if (whoami?.role === 'runtime') {
        throw redirect({ to: '/runtime-sign-in' })
      }
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
        // top-center, not bottom-center: bottom-center sits over a Browser
        // tile's body, and that native webview always paints above the DOM
        // (see useNativeOverlayBlocker's doc comment) — no z-index fixes it.
        position="top-center"
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
