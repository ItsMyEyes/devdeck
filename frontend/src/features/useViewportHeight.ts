import { useEffect } from 'react'

/**
 * Keeps the --app-height CSS var in sync with window.visualViewport, which
 * (unlike vh/dvh units) actually shrinks when a mobile on-screen keyboard
 * opens. Layouts anchored with h-[var(--app-height)] instead of h-screen
 * therefore keep their bottom edge (e.g. MobileKeyToolbar) above the
 * keyboard rather than pushed off-screen underneath it.
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    const set = () => {
      const height = vv?.height ?? window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${height}px`)
    }
    set()
    vv?.addEventListener('resize', set)
    window.addEventListener('resize', set)
    return () => {
      vv?.removeEventListener('resize', set)
      window.removeEventListener('resize', set)
    }
  }, [])
}
