import { Minus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Window as TauriWindow } from '@tauri-apps/api/window'
import { cn } from '@/lib/utils'

/** Windows/Linux caption buttons (minimize/maximize/close), fused into the
 *  tab strip's top-right corner in place of macOS's natively-overlaid
 *  traffic lights — those platforms run `decorations: false`
 *  (tauri.windows.conf.json / tauri.linux.conf.json) to match macOS's
 *  chrome-free look, so nothing else draws window controls. Only mounted
 *  when `!useIsMacTauri()`; see `TileLeafHeader` in WorkspaceTileCanvas.tsx. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  // Resolved once on mount rather than re-imported per click: cheap either
  // way (the module's already loaded elsewhere by the time this mounts),
  // but a ref means a button pressed in the first instant after mount
  // never races a half-finished dynamic import.
  const winRef = useRef<TauriWindow | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (cancelled) return
      const win = getCurrentWindow()
      winRef.current = win
      win.isMaximized().then((value) => {
        if (!cancelled) setMaximized(value)
      })
      win.onResized(() => {
        win.isMaximized().then((value) => {
          if (!cancelled) setMaximized(value)
        })
      }).then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
    })
    return () => {
      cancelled = true
      unlisten?.()
      winRef.current = null
    }
  }, [])

  return (
    <div className="ml-1 flex h-full flex-none items-stretch">
      <button
        type="button"
        onClick={() => winRef.current?.minimize()}
        aria-label="Minimize"
        title="Minimize"
        className={controlButtonClass}
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        onClick={() => winRef.current?.toggleMaximize()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        className={controlButtonClass}
      >
        <Square size={10} />
      </button>
      <button
        type="button"
        onClick={() => winRef.current?.close()}
        aria-label="Close"
        title="Close"
        className={cn(controlButtonClass, 'hover:bg-devdeck-err hover:text-white')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

const controlButtonClass =
  'flex w-11 flex-none items-center justify-center text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset'
