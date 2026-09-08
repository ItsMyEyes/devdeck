// Drives the guided tour.
//
// driver.js is loaded on demand — it is only ever needed after a deliberate
// click on the "?" button (or the one automatic first run), and there is no
// reason for every cold start of the app to pay for a library most sessions
// never open. Its stylesheet is *not* lazy: it comes in through globals.css
// alongside xterm's, so the DevDeck overrides that follow it there are
// guaranteed to win the cascade no matter when the JS arrives.

import type { Driver } from 'driver.js'
import type { TourChapter } from './tourAnchors'
import { tourCopy } from './tourCopy'
import { buildTourSteps } from './tourSteps'
import { markTourSeen, readTourLang, type TourLang } from './tourPrefs'

/** The one live instance, if any. driver.js is happy to run two tours at once
 *  and the result is two overlays fighting over the same backdrop, so a second
 *  start replaces the first rather than stacking on it. */
let active: Driver | null = null

/** Subscribers to "is a tour on screen right now". HelpFab uses this to hold a
 *  native-webview occlusion blocker up for the tour's lifetime: driver.js
 *  paints its backdrop in the DOM, and in the desktop shell a Browser tile is
 *  an OS webview stacked above the entire DOM, so without the blocker the tour
 *  would simply be invisible over one. */
const activeListeners = new Set<(running: boolean) => void>()

function setActive(next: Driver | null) {
  if ((active !== null) === (next !== null)) {
    active = next
    return
  }
  active = next
  activeListeners.forEach((listener) => listener(next !== null))
}

export function isTourActive(): boolean {
  return active !== null
}

export function subscribeTourActive(listener: (running: boolean) => void): () => void {
  activeListeners.add(listener)
  return () => {
    activeListeners.delete(listener)
  }
}

/** Ends the tour if one is running. Safe to call when none is. */
export function stopTour(): void {
  const running = active
  // Cleared first: `destroy()` fires `onDestroyed`, which calls back in here.
  setActive(null)
  running?.destroy()
}

/**
 * Starts one chapter of the tour in `lang` (defaulting to the stored
 * preference).
 *
 * Resolves once the tour is on screen, not when it finishes — the caller is a
 * click handler, and the tour outlives it.
 */
export async function startTour(chapter: TourChapter = 'overview', lang: TourLang = readTourLang()): Promise<void> {
  const { driver } = await import('driver.js')
  stopTour()

  const { chrome } = tourCopy(lang)
  const instance = driver({
    steps: buildTourSteps(chapter, lang),
    popoverClass: 'devdeck-tour',
    showProgress: true,
    progressText: chrome.progress,
    nextBtnText: chrome.next,
    prevBtnText: chrome.previous,
    doneBtnText: chrome.done,
    smoothScroll: true,
    stagePadding: 6,
    stageRadius: 10,
    // The tour narrates the controls; it must not fire them. Without this,
    // "Next" on the New agent step is one stray click away from opening the
    // spawn dialog underneath the overlay and leaving the reader stranded.
    disableActiveInteraction: true,
    // Belt to buildTourSteps' braces: it filters anchors that are missing when
    // the tour starts, this covers one disappearing while it runs (a transfer
    // finishing, a card being deleted from another tab).
    skipMissingElement: true,
    onDestroyed: () => {
      // Finished *or* dismissed with Esc/the backdrop — either way the operator
      // has seen this chapter, so the automatic first run must not fire again
      // and the "?" panel offers it back as "Replay".
      markTourSeen(chapter)
      setActive(null)
    },
  })

  setActive(instance)
  instance.drive()
}
