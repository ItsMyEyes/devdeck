import { useEffect } from 'react'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Raises `nativeOverlayBlockers` while `active` is true. The desktop Browser
 *  tile is a native OS webview stacked above the entire app DOM (see
 *  `BrowserTile`'s effect on `nativeOverlayBlockers`) — no CSS `z-index` can
 *  put a DOM overlay in front of one, so every overlay that must appear above
 *  a Browser tile (dialogs, dropdowns, tooltips, popovers, the mobile
 *  sidebar) has to call this for as long as it's open. */
export function useNativeOverlayBlocker(active: boolean): void {
  const pushNativeOverlayBlocker = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const popNativeOverlayBlocker = useDevDeckStore((s) => s.popNativeOverlayBlocker)

  useEffect(() => {
    if (!active) return
    pushNativeOverlayBlocker()
    return () => popNativeOverlayBlocker()
  }, [active, pushNativeOverlayBlocker, popNativeOverlayBlocker])
}
