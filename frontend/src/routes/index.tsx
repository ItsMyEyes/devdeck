import { Navigate, createFileRoute, redirect } from '@tanstack/react-router'
import { fetchSettings, fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { useSettings, useWorkspaces } from '@/features/data/queries'
import { OnboardingScreen } from '@/features/screens/OnboardingScreen'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const qc = context.queryClient
    let target: string | undefined
    try {
      const [workspaces, settings] = await Promise.all([
        qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces }),
        qc.ensureQueryData({ queryKey: qk.settings, queryFn: fetchSettings }),
      ])
      const active = workspaces.find((w) => w.id === settings.activeWorkspaceId)
      target = active?.id ?? workspaces[0]?.id
    } catch {
      // Backend unreachable — fall through to the component's error state.
    }
    if (target) throw redirect({ to: '/w/$wsId', params: { wsId: target } })
  },
  component: IndexRoute,
})

/** Reached only when there are no workspaces, or the backend is unreachable. */
function IndexRoute() {
  const workspaces = useWorkspaces()
  const settings = useSettings()

  if (workspaces.isPending) {
    return (
      <div className="flex h-screen w-full flex-col bg-devdeck-bg text-devdeck-fg">
        <DataLoading label="loading workspaces…" />
      </div>
    )
  }
  if (workspaces.isError) {
    return (
      <div className="flex h-screen w-full flex-col bg-devdeck-bg text-devdeck-fg">
        <DataError error={workspaces.error} onRetry={() => workspaces.refetch()} />
      </div>
    )
  }
  // beforeLoad only redirects on the initial load. If we recovered here after a
  // failed load (e.g. backend was down, then Retry succeeded) and workspaces now
  // exist, redirect instead of showing the onboarding / seed screen — whose
  // "Load demo data" wipes the database.
  const list = workspaces.data ?? []
  if (list.length > 0) {
    const active = list.find((w) => w.id === settings.data?.activeWorkspaceId)
    return <Navigate to="/w/$wsId" params={{ wsId: active?.id ?? list[0].id }} />
  }
  return <OnboardingScreen />
}
