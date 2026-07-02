import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from 'sonner'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
})

function RootComponent() {
  return (
    <>
      <Outlet />
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--loom-elevated)',
            border: '1px solid var(--loom-border-accent)',
            color: 'var(--loom-fg-2)',
            fontSize: '12.5px',
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </>
  )
}
