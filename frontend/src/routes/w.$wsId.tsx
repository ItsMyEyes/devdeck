import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { useSettings, useUpdateSettings, useWorkspaces } from '@/features/data/queries'
import { Header } from '@/features/layout/Header'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { GlobalOverlays } from '@/features/overlays/GlobalOverlays'
import { WorkspaceTileArea } from '@/features/tabs/WorkspaceTileArea'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { cn } from '@/lib/utils'
import { useLoomStore } from '@/store/useLoomStore'

/** Matches only the worktree route, e.g. /w/abc/p/def/wt/ghi (the ExpandedTerminal screen). */
const WORKSPACE_MODE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+\/wt\/[^/]+/
/** Matches the Agents grid or a worktree terminal — the two routes
 *  `WorkspaceTileArea` renders itself, bypassing `<Outlet/>`, once tiling
 *  is active. Every other workspace route (Machines, Tools, News, ...)
 *  keeps rendering via `<Outlet/>` as before. */
const AGENTS_SCOPE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+(\/wt\/[^/]+)?$/

export const Route = createFileRoute('/w/$wsId')({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient
    let workspaces
    try {
      workspaces = await qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
    } catch {
      return // backend down — the layout renders the error state
    }
    if (workspaces.length === 0) throw redirect({ to: '/' })
    if (!workspaces.some((w) => w.id === params.wsId)) {
      throw redirect({ to: '/w/$wsId', params: { wsId: workspaces[0].id } })
    }
  },
  component: WorkspaceLayout,
})

function WorkspaceLayout() {
  const { wsId } = Route.useParams()
  const setSidebarOpen = useLoomStore((s) => s.setSidebarOpen)
  const pathname = useLocation({ select: (l) => l.pathname })
  const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)
  const isTauri = useIsTauri()
  const inTiledScope = isTauri && AGENTS_SCOPE_PATTERN.test(pathname)

  const workspaces = useWorkspaces()
  const settings = useSettings()
  const updateSettings = useUpdateSettings()

  // Keep the server-side "active workspace" in sync with the URL.
  const activeWorkspaceId = settings.data?.activeWorkspaceId
  useEffect(() => {
    if (settings.data && activeWorkspaceId !== wsId) {
      updateSettings.mutate({ activeWorkspaceId: wsId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, activeWorkspaceId, settings.data])

  // Close the mobile sidebar whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname, setSidebarOpen])

  if (workspaces.isPending) {
    return (
      <div className="flex h-[var(--app-height)] w-full flex-col bg-loom-bg text-loom-fg">
        <DataLoading label="loading workspace…" />
      </div>
    )
  }
  if (workspaces.isError) {
    return (
      <div className="flex h-[var(--app-height)] w-full flex-col bg-loom-bg text-loom-fg">
        <DataError error={workspaces.error} onRetry={() => workspaces.refetch()} />
      </div>
    )
  }

  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden bg-loom-bg text-loom-fg">
      {!workspaceMode && <Header />}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar compact={workspaceMode} />
        <section className="flex min-w-0 flex-1 flex-col bg-loom-bg">
          {isTauri ? (
            <div className={cn('flex min-h-0 flex-1 flex-col', !inTiledScope && 'hidden')}>
              <WorkspaceTileArea wsId={wsId} />
            </div>
          ) : null}
          {!inTiledScope ? <Outlet /> : null}
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
}
