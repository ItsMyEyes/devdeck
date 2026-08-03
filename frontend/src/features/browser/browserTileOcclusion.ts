import type { OverlayBlockerRegion } from '@/store/types'

/** A measured on-screen rect — structurally identical to `OverlayBlockerRect`
 *  but named separately since this side of the comparison is always a live
 *  `getBoundingClientRect()` result, not a stored blocker region. */
export interface TileRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function rectsIntersect(a: TileRect, b: TileRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** The occlusion decision rule (chrome-replication design spec §5.4):
 *  `tileDragActive` short-circuits to an immediate, geometry-free hide
 *  (an interactive divider drag needs zero latency, and native webviews lag
 *  behind fast CSS resizes — see `WorkspaceTileCanvas.tsx`'s `TileSplitView`).
 *  Otherwise, hide only for a `'viewport'` blocker (unconditional, matches
 *  today's behavior for app-wide overlays) or a rect blocker that actually
 *  overlaps `tileRect` — the core of the "stop blinking for overlays
 *  nowhere near this tile" fix. */
export function tileShouldBeHidden(
  tileRect: TileRect,
  blockers: Record<string, OverlayBlockerRegion>,
  tileDragActive: boolean,
): boolean {
  if (tileDragActive) return true
  for (const region of Object.values(blockers)) {
    if (region === 'viewport') return true
    if (rectsIntersect(tileRect, region)) return true
  }
  return false
}
