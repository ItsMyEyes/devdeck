// Per-device preferences for the guided tour: which language it speaks, and
// whether it has already run once by itself.
//
// Deliberately NOT in the zustand store or the server `settings` row. The tour
// is device-local chrome, not workspace state — a hub operator who took the
// tour on their laptop should still get it offered on a phone, and a runtime's
// own web UI has no settings row of its own to hang it off. Same reasoning (and
// the same defensive read/write shape) as `lib/ripgrepInstallPrefs.ts`:
// private browsing or storage-disabled environments must degrade to a sane
// default, never throw.

import type { TourChapter } from './tourAnchors'

export type TourLang = 'id' | 'en'

export const TOUR_LANG_STORAGE_KEY = 'devdeck.tour.lang'
export const TOUR_SEEN_STORAGE_KEY = 'devdeck.tour.seen'

/** Seen-ness is per chapter — the panel lists four tours, and labelling the SSH
 *  one "Replay" because someone once watched the overview would be a lie.
 *
 *  `overview` keeps the bare, unsuffixed key it has always written: it is the
 *  one the automatic first run consults, and moving it would re-offer the
 *  unprompted tour to every operator who has already dismissed it. */
function seenKey(chapter: TourChapter): string {
  return chapter === 'overview' ? TOUR_SEEN_STORAGE_KEY : `${TOUR_SEEN_STORAGE_KEY}.${chapter}`
}

/** Listeners for the language, so the "?" button's label and an open menu
 *  re-render together the moment the choice changes. One module-level set is
 *  enough — `subscribeTourLang` is only ever used by `useTourLang`. */
const langListeners = new Set<(lang: TourLang) => void>()

function isTourLang(value: unknown): value is TourLang {
  return value === 'id' || value === 'en'
}

/** Indonesian for an Indonesian browser, English for everything else. DevDeck's
 *  own UI is English-only, so this is the tour's guess at the *reader*, not at
 *  the app. */
export function detectTourLang(): TourLang {
  if (typeof navigator === 'undefined') return 'en'
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language]
  return tags.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('id')) ? 'id' : 'en'
}

export function readTourLang(): TourLang {
  if (typeof window === 'undefined') return 'en'
  try {
    const raw = window.localStorage.getItem(TOUR_LANG_STORAGE_KEY)
    if (isTourLang(raw)) return raw
  } catch {
    // Storage disabled — fall through to the browser's own language.
  }
  return detectTourLang()
}

export function setTourLang(next: TourLang): void {
  try {
    window.localStorage.setItem(TOUR_LANG_STORAGE_KEY, next)
  } catch {
    // Storage disabled: the choice still applies to this session via the
    // listeners below, it just won't survive a reload.
  }
  langListeners.forEach((listener) => listener(next))
}

export function subscribeTourLang(listener: (lang: TourLang) => void): () => void {
  langListeners.add(listener)
  return () => {
    langListeners.delete(listener)
  }
}

export function hasSeenTour(chapter: TourChapter = 'overview'): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(seenKey(chapter)) === '1'
  } catch {
    // Can't remember that it ran, so don't auto-run it: an unskippable tour on
    // every single load is far worse than never offering it unprompted. The
    // "?" button still starts it on demand.
    return true
  }
}

export function markTourSeen(chapter: TourChapter = 'overview'): void {
  try {
    window.localStorage.setItem(seenKey(chapter), '1')
  } catch {
    // See hasSeenTour: unwritable storage already reads as "seen".
  }
}
