import { useEffect, useRef } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMintHandoverToken } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { DataError } from '@/features/screens/DataError'
import { meQueryOptions } from '@/features/data/authQueries'

/**
 * Reached only via a top-level navigation FROM a runtime's own sign-in page
 * (RuntimeSignIn.tsx's "Sign in via hub" button) — never linked to from
 * within this app's own UI. Mints a handover token for the requested
 * machine and sends the browser back to it.
 *
 * Why this can't be a same-page fetch from the runtime: the hub's session
 * cookie is SameSite=Strict, so it is never attached to a cross-origin
 * request, including a top-level navigation initiated from a different
 * origin. This route exists specifically to be the SAME-origin leg of that
 * handshake — it only ever runs with the hub's own cookie in play.
 */
export const Route = createFileRoute('/handover')({
  validateSearch: (search: Record<string, unknown>) => ({
    machine: typeof search.machine === 'string' ? search.machine : '',
    return: typeof search.return === 'string' ? search.return : '',
  }),
  beforeLoad: async ({ context, search, location }) => {
    if (!search.machine || !search.return) {
      throw redirect({ to: '/' })
    }
    try {
      // meQueryOptions is the app's own established auth-check query,
      // exported specifically so "the root route guard's ensureQueryData
      // and useMe() behave identically" (see its doc comment in
      // authQueries.ts) — reused here rather than a bespoke check.
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login', search: { next: location.href } })
    }
  },
  component: HandoverPage,
})

function HandoverPage() {
  const { machine, return: returnUrl } = Route.useSearch()
  const mint = useMintHandoverToken()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    mint.mutate(machine, {
      onSuccess: ({ token }) => {
        window.location.href = `${returnUrl}?t=${encodeURIComponent(token)}`
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (mint.isError) {
    return (
      <div className="flex h-[100dvh] w-full flex-col bg-devdeck-pane text-devdeck-fg">
        <DataError error={mint.error} onRetry={() => mint.mutate(machine)} />
      </div>
    )
  }
  return (
    <div className="flex h-[100dvh] w-full flex-col bg-devdeck-pane text-devdeck-fg">
      <DataLoading label="signing you in…" />
    </div>
  )
}
