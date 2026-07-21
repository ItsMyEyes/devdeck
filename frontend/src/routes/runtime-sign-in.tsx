import { createFileRoute } from '@tanstack/react-router'
import { useWhoami } from '@/features/data/queries'
import { RuntimeSignIn } from '@/features/auth/RuntimeSignIn'

/**
 * The landing page for an unauthenticated visitor on a --role runtime
 * process — see __root.tsx's beforeLoad, which redirects here instead of
 * /login once it learns (via the now-public /api/whoami) that this process
 * is a runtime, not a hub.
 */
export const Route = createFileRoute('/runtime-sign-in')({
  component: RuntimeSignInPage,
})

function RuntimeSignInPage() {
  const whoami = useWhoami()
  return (
    <RuntimeSignIn
      machineName={whoami.data?.machineName ?? ''}
      hubUrl={whoami.data?.hubUrl ?? ''}
      machineId={whoami.data?.machineId ?? ''}
    />
  )
}
