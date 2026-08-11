import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { useSettings, useUpdateSettings, useWorkspaces } from '@/features/data/queries'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { GlobalOverlays } from '@/features/overlays/GlobalOverlays'
import { WorkspaceTileArea } from '@/features/tabs/WorkspaceTileArea'
import { useHasMacVibrancy, useIsTauri } from '@/features/tabs/useIsTauri'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { useReducedTransparency } from '@/features/useReducedTransparency'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Matches only the worktree route, e.g. /w/abc/p/def/wt/ghi (the ExpandedTerminal screen). */
const WORKSPACE_MODE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+\/wt\/[^/]+/
/** Matches workspace routes whose body is owned by the persisted tile tree:
 *  all-project agents, browser tiles, project agents, and worktree terminals.
 *  Every other workspace route (Machines, Tools, News, ...) keeps rendering via
 *  `<Outlet/>` — but `WorkspaceTileArea`'s pinned tab strip stays mounted and
 *  visible regardless, as persistent Tauri chrome; see `showContent` below. */
const TILED_SCOPE_PATTERN = /^\/w\/[^/]+(?:\/browser|\/p\/[^/]+(?:\/wt\/[^/]+)?)?\/?$/

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
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const pathname = useLocation({ select: (l) => l.pathname })
  const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)
  const isTauri = useIsTauri()
  const hasMacVibrancy = useHasMacVibrancy()
  const reducedTransparency = useReducedTransparency()
  const inTiledScope = isTauri && TILED_SCOPE_PATTERN.test(pathname)

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
      <div className="flex h-[var(--app-height)] w-full flex-col bg-devdeck-pane text-devdeck-fg">
        <DataLoading label="loading workspace…" />
      </div>
    )
  }
  if (workspaces.isError) {
    return (
      <div className="flex h-[var(--app-height)] w-full flex-col bg-devdeck-pane text-devdeck-fg">
        <DataError error={workspaces.error} onRetry={() => workspaces.refetch()} />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex h-[var(--app-height)] w-full flex-col overflow-hidden text-devdeck-fg',
        // One glass layer covers the ENTIRE window. An earlier revision put
        // glass only on the rail and sidebar, which let raw wallpaper bleed
        // through the gaps around the pane and produced a bright band along
        // the window's bottom edge. Covering everything makes the wallpaper a
        // colour cast rather than a visible area.
        //
        // On Tauri-for-macOS this div stays transparent on purpose: the
        // window itself is transparent with native `windowEffects: sidebar`
        // vibrancy (tauri.macos.conf.json), composited by macOS rather than
        // blurred inside the webview. Painting the CSS glass approximation
        // on top would stack an 80%-opaque fill over that native material
        // and hide it — see DESIGN.md §1. The native material also honours
        // prefers-reduced-transparency on its own, so `reducedTransparency`
        // only matters below. Windows/Linux Tauri builds have no native
        // transparency configured (`useHasMacVibrancy`'s doc comment), so
        // they fall through to the same CSS path as the web build.
        hasMacVibrancy
          ? undefined
          : reducedTransparency
            ? 'bg-devdeck-glass-solid'
            : 'bg-devdeck-glass [backdrop-filter:var(--devdeck-glass-filter)]',
        // Reserves space for WorkspaceTileCanvas's top-left leaf strip,
        // which is `fixed` to the true viewport top (see
        // WorkspaceTileCanvas.tsx) so it visually merges with macOS's
        // overlaid traffic-light buttons instead of sitting behind Header.
        // The strip is persistent chrome on every Tauri route now, not
        // just the Agents/worktree ones, so this reserves space whenever
        // isTauri — matching the always-mounted WorkspaceTileArea below.
        isTauri && 'pt-10',
      )}
    >
      {/* The tab strip already serves as Tauri's top bar (traffic lights,
          tabs, "+" spawn action) on every workspace route — Header would
          just duplicate it, so it only renders on the web build. */}
      {/* {!workspaceMode && !isTauri && <Header />} */}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar mobileDrawer={!workspaceMode && !isTauri} />
        <section className="flex min-w-0 flex-1 flex-col gap-[var(--devdeck-gap)] p-[var(--devdeck-gap)] pl-0">
          {isTauri ? (
            // Always mounted so the pinned strip never disappears; only its
            // tiling body is suppressed off the tile-owned routes
            // (`showContent={inTiledScope}`), where it collapses to just
            // the `fixed` header and `<Outlet/>` below takes the content area.
            <div className={cn('flex min-h-0 flex-col', inTiledScope ? 'flex-1' : 'flex-none')}>
              <WorkspaceTileArea wsId={wsId} showContent={inTiledScope} />
            </div>
          ) : null}
          {!inTiledScope ? <Outlet /> : null}
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
}
