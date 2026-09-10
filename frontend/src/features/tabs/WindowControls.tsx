import { Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/** Windows/Linux caption buttons (minimize/maximize/close), fused into the
 *  tab strip's top-right corner in place of macOS's natively-overlaid
 *  traffic lights — those platforms run `decorations: false`
 *  (tauri.windows.conf.json / tauri.linux.conf.json) to match macOS's
 *  chrome-free look, so nothing else draws window controls. Only mounted
 *  when `!useIsMacTauri()`; see `TileLeafHeader` in WorkspaceTileCanvas.tsx.
 *
 *  The window handle is resolved per click, from a STATICALLY imported
 *  `getCurrentWindow`, and every failure is reported. Both of those are
 *  deliberate, and both replace a mechanism that could only fail invisibly:
 *
 *  1. The previous revision resolved the handle once in a mount effect via
 *     `import('@tauri-apps/api/window')` and stored it in a ref, so *any*
 *     failure on that path — the lazily-fetched chunk 404ing or arriving as
 *     the SPA's index.html (DevDeck's UI is served over HTTP by a hub that
 *     may be remote, so a chunk fetch is a real network request that can
 *     fail or race a hub restart), or `getCurrentWindow()` throwing on a
 *     webview with no injected `metadata` — left the ref null forever. Every
 *     button then did nothing, silently, for the life of the page:
 *     `winRef.current?.minimize()` no-ops on null and the rejected promise
 *     was never awaited. `getCurrentWindow()` is synchronous and reads a
 *     global the Tauri init script has already injected, so calling it at
 *     click time cannot race anything.
 *
 *  2. A denied ACL is the other invisible failure: Tauri answers a command
 *     the capability doesn't grant by *rejecting* the invoke with the reason
 *     ("window.minimize not allowed. Permissions associated with this
 *     command: ..."). Unawaited, that reads exactly like a dead button. The
 *     toast is what makes a misconfigured `capabilities/default.json`
 *     diagnosable from the app instead of only from a devtools console the
 *     desktop build doesn't open by default. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const win = currentWindow()
    if (!win) return

    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (!cancelled) setMaximized(value)
        })
        .catch(() => {
          // Cosmetic only — the button keeps its last label and still works.
        })
    }

    sync()
    void win
      .onResized(sync)
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {
        // Without the listener the label can go stale after an OS-side
        // maximize (double-click, Win+Up, snap); the buttons still act.
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return (
    <div className="ml-1 flex h-full flex-none items-stretch">
      <button
        type="button"
        onClick={() => run('minimize', (win) => win.minimize())}
        aria-label="Minimize"
        title="Minimize"
        className={controlButtonClass}
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        onClick={() => run(maximized ? 'restore' : 'maximize', (win) => win.toggleMaximize())}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        className={controlButtonClass}
      >
        <Square size={10} />
      </button>
      <button
        type="button"
        onClick={() => run('close', (win) => win.close())}
        aria-label="Close"
        title="Close"
        className={cn(controlButtonClass, 'hover:bg-devdeck-err hover:text-white')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

/** The current Tauri window, or null when there is none to talk to. Never
 *  throws: `getCurrentWindow()` reads `__TAURI_INTERNALS__.metadata`, which a
 *  webview outside the desktop shell (or one whose init script did not run)
 *  does not have. */
function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

/** Runs one caption-button action, surfacing anything that stops it from
 *  happening — see this module's doc comment for why silence is the failure
 *  mode worth designing against here. */
function run(action: string, act: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>): void {
  const win = currentWindow()
  if (!win) {
    console.error(`WindowControls: cannot ${action} — no Tauri window in this webview`)
    toast.error(`Could not ${action} the window`, { description: 'The desktop window API is unavailable here.' })
    return
  }
  // Invoked synchronously, not deferred through a microtask: a caption button
  // must reach the runtime on the click itself, and `close()` in particular
  // races the window teardown that follows it.
  try {
    void act(win).catch(report)
  } catch (err) {
    report(err)
  }

  function report(err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`WindowControls: ${action} failed:`, err)
    toast.error(`Could not ${action} the window`, { description: detail })
  }
}

const controlButtonClass =
  'flex w-11 flex-none items-center justify-center text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset'
