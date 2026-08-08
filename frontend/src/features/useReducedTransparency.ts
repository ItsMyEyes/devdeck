import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-transparency: reduce)'

/** True when the OS asks apps to avoid translucency (macOS Accessibility →
 *  Display → Reduce transparency, and equivalents).
 *
 *  The whole chrome rests on a glass material, so people who turn this on need
 *  a real answer, not a slightly-less-blurry one. The design swaps the glass
 *  for a solid `--devdeck-glass-solid` and changes nothing else — gaps, radii,
 *  the state wash, and both text scales all still pass on that surface.
 *
 *  Browser support for this query is uneven. Treating "no match" as "wants
 *  transparency" is the safe default: a browser that does not know the query
 *  gets the normal design rather than a permanently degraded one. On Tauri the
 *  native material honours the OS setting on its own, so this mainly serves
 *  the web build. */
export function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setReduced(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
