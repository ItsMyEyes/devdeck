/** Fixed zoom steps (50%-300%), matching the design spec §3.6's "clamp
 *  50-300% in fixed steps" — the frontend owns this as source of truth
 *  since `browser_tile_set_zoom` has no matching getter on the Tauri side. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const DEFAULT_ZOOM = 1

function nearestIndex(current: number): number {
  let best = 0
  let bestDiff = Infinity
  ZOOM_LEVELS.forEach((level, i) => {
    const diff = Math.abs(level - current)
    // `<=`, not `<`: on an exact tie (e.g. 1.05 is equidistant from 1 and
    // 1.1), the higher index wins so stepping up from a tied value lands on
    // the *next* level rather than re-landing on the nearer-in-array-order
    // one — see browserZoom.test.ts's off-table-value case.
    if (diff <= bestDiff) {
      best = i
      bestDiff = diff
    }
  })
  return best
}

/** One step up (`1`) or down (`-1`) `ZOOM_LEVELS` from whichever entry is
 *  nearest `current` — snaps an off-table value (e.g. a stale/rounded
 *  number) onto the table before stepping, and clamps at either end
 *  instead of wrapping. */
export function zoomStep(current: number, direction: 1 | -1): number {
  const next = nearestIndex(current) + direction
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, next))]
}
