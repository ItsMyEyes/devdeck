import { useEffect, useId } from 'react'
import type { RefObject } from 'react'
import type { OverlayBlockerRect } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Pushes a scoped occlusion blocker while `active` is true. The desktop
 *  Browser tile is a native OS webview stacked above the entire app DOM (see
 *  `BrowserTile`'s occlusion effect) — no CSS `z-index` can put a DOM
 *  overlay in front of one, so every overlay that must appear above a
 *  Browser tile (dialogs, dropdowns, tooltips, popovers, the mobile
 *  sidebar) has to call this for as long as it's open.
 *
 *  `rectRef` is optional and a true drop-in: omitting it (or passing a ref
 *  whose `.current` is still null when this fires) pushes a `'viewport'`
 *  blocker, reproducing today's "hide every open Browser tile" behavior
 *  exactly. Passing a ref to the overlay's own positioned element instead
 *  scopes the blocker to that element's live rect, so a Browser tile only
 *  hides when this overlay's rect actually overlaps it — see the
 *  chrome-replication design spec §5.2/§5.3 for which call sites should
 *  make that switch and which should deliberately stay `'viewport'`.
 *
 *  `live` is for a rect that moves via CSS transform rather than layout
 *  (e.g. a `@dnd-kit/core` `DragOverlay` ghost following the pointer) —
 *  transforms change neither the element's border-box size nor fire a
 *  window scroll/resize event, so `ResizeObserver` + those listeners never
 *  re-fire while it's being dragged. `live` swaps to a per-frame
 *  `requestAnimationFrame` re-measure instead, so the blocker's rect keeps
 *  tracking the element for as long as it stays mounted. */
export function useNativeOverlayBlocker(
  active: boolean,
  rectRef?: RefObject<HTMLElement | null>,
  live?: boolean,
): void {
  const push = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const pop = useDevDeckStore((s) => s.popNativeOverlayBlocker)
  const id = useId()

  useEffect(() => {
    if (!active) return
    if (!rectRef?.current) {
      push(id, 'viewport')
      return () => pop(id)
    }
    const el = rectRef.current
    // `live` re-measures every animation frame, but a ghost held still under a
    // stationary pointer reports the same rect each time — skipping the
    // unchanged push keeps those frames from writing to the store and
    // re-rendering every subscriber for nothing.
    let last: OverlayBlockerRect | null = null
    const update = () => {
      const r = el.getBoundingClientRect()
      if (last && last.left === r.left && last.top === r.top && last.right === r.right && last.bottom === r.bottom) {
        return
      }
      last = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      push(id, last)
    }
    update()

    if (live) {
      let frame = requestAnimationFrame(function tick() {
        update()
        frame = requestAnimationFrame(tick)
      })
      return () => {
        cancelAnimationFrame(frame)
        pop(id)
      }
    }

    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      pop(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rectRef, live, push, pop, id])
}
