import { useEffect } from 'react'
import { tourSelector } from './tourAnchors'
import { hasSeenTour } from './tourPrefs'
import { startTour } from './startTour'

/** The one anchor that is present on every workspace route, so its arrival is
 *  a reliable "the shell has painted" signal. */
const READY_SELECTOR = tourSelector('nav-rail')
const POLL_MS = 150
const GIVE_UP_MS = 4000

/**
 * Runs the tour once, unprompted, for someone who has never seen it.
 *
 * Polling rather than a fixed delay: the workspace shell paints after its
 * queries resolve, and on a cold hub over a tunnel that can be a second or
 * more. Starting on a timer would spotlight a half-built screen.
 *
 * Giving up quietly is deliberate — the "seen" flag is only written when the
 * tour actually runs (`startTour`'s `onDestroyed`), so a session that never got
 * far enough to render the rail simply gets the offer again next time rather
 * than losing it for good.
 */
export function useTourAutoStart(enabled = true): void {
  useEffect(() => {
    if (!enabled || hasSeenTour()) return
    const deadline = Date.now() + GIVE_UP_MS
    let timer = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      if (document.querySelector(READY_SELECTOR)) {
        void startTour()
        return
      }
      if (Date.now() >= deadline) return
      timer = window.setTimeout(tick, POLL_MS)
    }
    timer = window.setTimeout(tick, POLL_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled])
}
