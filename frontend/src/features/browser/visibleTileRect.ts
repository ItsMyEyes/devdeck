import type { OverlayBlockerRegion } from '@/store/types'

/** A measured on-screen rect — structurally identical to `OverlayBlockerRect`,
 *  but this side of the comparison is always a live `getBoundingClientRect()`
 *  result rather than a stored blocker region. */
export interface TileRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function rectsIntersect(a: TileRect, b: TileRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Below this share of the tile's original area, showing the remainder is worse
 *  than showing nothing: a sliver of a web page pinned to one edge reads as a
 *  rendering fault, while a clean blank reads as "something is covering this".
 *  Tuned so an edge dropdown or toolbar popover keeps the page (they leave
 *  70-85%) while a centred dialog-sized overlay does not (it leaves ~33%). */
export const MIN_VISIBLE_AREA_FRACTION = 0.5

function area(rect: TileRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
}

/** The largest of the four rectangles left when `blocker` is cut out of `rect`.
 *  A native webview is a single axis-aligned surface — it cannot be given an
 *  L-shape — so one of the four half-plane remainders is the best available
 *  answer, not an approximation we could improve on. */
function largestRemainder(rect: TileRect, blocker: TileRect): TileRect {
  const candidates: TileRect[] = [
    { ...rect, bottom: Math.min(rect.bottom, blocker.top) },
    { ...rect, top: Math.max(rect.top, blocker.bottom) },
    { ...rect, right: Math.min(rect.right, blocker.left) },
    { ...rect, left: Math.max(rect.left, blocker.right) },
  ]
  return candidates.reduce((best, candidate) => (area(candidate) > area(best) ? candidate : best))
}

/**
 * Where a Browser tile's native webview may actually be shown, or `null` to
 * hide it entirely.
 *
 * Replaces the previous all-or-nothing rule. A native webview stacks above the
 * whole app DOM and cannot be partially occluded, so any DOM overlay that
 * touches it used to blank the entire page — a 300px machine dropdown wiped a
 * full-screen browser tile. Cutting the webview back to the largest uncovered
 * rectangle keeps the page on screen and still leaves the overlay unobstructed.
 *
 * `tileDragActive` and `'viewport'` blockers keep hiding unconditionally: a
 * divider drag needs zero-latency hiding (native webviews lag fast CSS
 * resizes), and `'viewport'` means "assume this covers everything".
 */
export function visibleTileRect(
  tileRect: TileRect,
  blockers: Record<string, OverlayBlockerRegion>,
  tileDragActive: boolean,
): TileRect | null {
  if (tileDragActive) return null

  const full = area(tileRect)
  if (full <= 0) return null

  let visible = tileRect
  for (const region of Object.values(blockers)) {
    if (region === 'viewport') return null
    if (!rectsIntersect(visible, region)) continue
    visible = largestRemainder(visible, region)
    // Cutting greedily one blocker at a time can strand the remainder against a
    // later one; bail as soon as there is nothing worth showing.
    if (area(visible) <= 0) return null
  }

  return area(visible) / full >= MIN_VISIBLE_AREA_FRACTION ? visible : null
}
