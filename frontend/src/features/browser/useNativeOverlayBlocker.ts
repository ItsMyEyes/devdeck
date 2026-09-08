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
 *  `rectRef` is optional and a true drop-in: omitting it pushes a
 *  `'viewport'` blocker, reproducing today's "hide every open Browser tile"
 *  behavior exactly. Passing a ref to the overlay's own positioned element
 *  instead scopes the blocker to that element's live rect, so a Browser tile
 *  only hides when this overlay's rect actually overlaps it — see the
 *  chrome-replication design spec §5.2/§5.3 for which call sites should
 *  make that switch and which should deliberately stay `'viewport'`.
 *
 *  Whether the ref is *populated* is deliberately not part of that choice.
 *  Base UI announces an overlay as open (`onOpenChange`) a commit before it
 *  commits the portalled popup, so `rectRef.current` is still null when this
 *  effect first runs for every portalled caller — a tooltip most visibly.
 *  Treating that as "no ref" pushed `'viewport'`, and since the deps hold no
 *  value that changes when the element lands, the blocker stayed viewport-wide
 *  for the whole hover: pointing at any tooltip anywhere blanked every open
 *  Browser tile. So a supplied ref waits per-frame for its element instead,
 *  then measures. Nothing is pushed in the meantime, which is correct rather
 *  than merely optimistic — an overlay with no element in the DOM yet has
 *  nothing for the native webview to cover, and it lands within one frame,
 *  well inside the popup's own fade-in.
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
    if (!rectRef) {
      push(id, 'viewport')
      return () => pop(id)
    }

    // `live` re-measures every animation frame, but a ghost held still under a
    // stationary pointer reports the same rect each time — skipping the
    // unchanged push keeps those frames from writing to the store and
    // re-rendering every subscriber for nothing.
    let last: OverlayBlockerRect | null = null
    let frame: number | null = null
    let observer: ResizeObserver | null = null

    // Reads `rectRef.current` per call rather than closing over the element:
    // it may not exist yet on the first call (see the header comment), and a
    // popup that remounts mid-open — Base UI reflows one to the other side
    // when it would overflow the viewport — swaps the node underneath us.
    const update = () => {
      const el = rectRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (last && last.left === r.left && last.top === r.top && last.right === r.right && last.bottom === r.bottom) {
        return
      }
      last = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      push(id, last)
    }

    if (live) {
      // Already re-measures forever, so a late-mounting element needs no
      // special handling here — `update` simply no-ops until it lands.
      frame = requestAnimationFrame(function tick() {
        update()
        frame = requestAnimationFrame(tick)
      })
      return () => {
        if (frame !== null) cancelAnimationFrame(frame)
        pop(id)
      }
    }

    const observe = (el: HTMLElement) => {
      observer = new ResizeObserver(update)
      observer.observe(el)
      window.addEventListener('scroll', update, true)
      window.addEventListener('resize', update)
    }

    // The ref is populated on the very next frame in practice; the loop is a
    // wait, not a poll, and it is bounded by the overlay's own lifetime —
    // cleanup cancels it when `active` goes false or the caller unmounts.
    const attach = () => {
      const el = rectRef.current
      if (!el) {
        frame = requestAnimationFrame(attach)
        return
      }
      frame = null
      update()
      observe(el)
    }
    attach()

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      pop(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rectRef, live, push, pop, id])
}
