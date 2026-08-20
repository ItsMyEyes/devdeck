import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { ToastHost } from '@/features/overlays/ToastHost'
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
      {/* Bottom-right, and safe there: a toast over a Browser tile's body used
          to be swallowed by that native webview (it paints above the whole DOM,
          which is why these sat at top-center), so ToastHost now scopes an
          occlusion blocker to the toast stack — see its doc comment. */}
      <ToastHost />
    </>
  )
}
