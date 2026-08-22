import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { routeTree } from './routeTree.gen'
import { qk } from './features/data/keys'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { AppErrorBoundary } from '@/features/screens/AppErrorBoundary'
import './styles/globals.css'

// Must run before first paint: flags the transparent-window CSS path in
// globals.css (`html.mac-vibrancy body`). Scoped to macOS specifically —
// native window vibrancy (tauri.macos.conf.json) only exists there; on
// Windows/Linux the native window stays opaque, so making the DOM
// transparent too would show nothing behind it. Mirrors
// useHasMacVibrancy() in features/tabs/useIsTauri.ts, duplicated here
// because this runs before React (and before first paint — a React effect
// would paint one opaque frame first and show a flash).
if ('__TAURI_INTERNALS__' in window && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) {
  document.documentElement.classList.add('mac-vibrancy')
}

// Every mutation surfaces its failure through sonner, and the devdeck query cache is
// re-fetched so the UI resyncs after a failed create/update/delete (e.g. a backend
// restart or a 404 from a concurrent delete) instead of staying silently stale.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
  mutationCache: new MutationCache({
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Request failed')
      queryClient.invalidateQueries({ queryKey: qk.workspaces })
      queryClient.invalidateQueries({ queryKey: qk.settings })
    },
  }),
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

/**
 * Desktop (Tauri) bootstrap: the shell launches the SPA at /?key=<hub key>.
 * Exchange it for a normal session cookie before the router's auth guard
 * runs, then scrub the key from the URL. No-op on the web (no ?key=).
 *
 * Also stashes the raw key in the store (in-memory only) before it's
 * otherwise discarded — DesktopSettingsDialog shows it masked-by-default so
 * self-registering a runtime doesn't require digging it out of Rust source
 * or sidecar logs. Not a new exposure: the frontend already receives this
 * exact value here today, just previously threw it away after the fetch.
 */
async function bootstrapDesktopSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const key = params.get('key')
  if (!key) return
  useDevDeckStore.getState().setHubApiKey(key)
  params.delete('key')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  try {
    const res = await fetch('/api/auth/key-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) console.error(`desktop key-session bootstrap failed: ${res.status}`)
  } catch (err) {
    console.error('desktop key-session bootstrap failed', err)
  }
}

function renderApp() {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('#root not found')

  createRoot(rootEl, {
    // React 19 routes errors an ErrorBoundary re-throws or never sees (an
    // update-depth loop can surface here rather than in a boundary) through
    // these. Logging `componentStack` is what makes a minified #185
    // diagnosable at all — see AppErrorBoundary's doc comment.
    onUncaughtError: (error, info) => {
      // eslint-disable-next-line no-console
      console.error(`[DevDeck] uncaught error: ${errMsg(error)}\ncomponent stack:${info.componentStack ?? ' (none)'}`, error)
    },
    onCaughtError: (error, info) => {
      // eslint-disable-next-line no-console
      console.error(`[DevDeck] caught error: ${errMsg(error)}\ncomponent stack:${info.componentStack ?? ' (none)'}`, error)
    },
  }).render(
    <StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AppErrorBoundary>
    </StrictMode>,
  )
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void bootstrapDesktopSession().finally(renderApp)
