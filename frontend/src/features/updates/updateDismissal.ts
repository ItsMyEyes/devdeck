// "Later" on the update pill, persisted.
//
// Deliberately NOT in `useDevDeckStore.ts`: that is a convergence file per
// `ORCHESTRATION.md`, and this state has to outlive a reload anyway — a
// dismissal that a refresh undoes is not a dismissal.
//
// Keyed by version string, so dismissing 0.2.1 silences 0.2.1 and nothing
// else. The next release re-prompts on its own.

const KEY = 'devdeck.updateDismissedVersion'

/** The version the operator last chose to skip, or `null`.
 *
 *  Every access is guarded: `localStorage` throws outright (not returns null)
 *  in a Safari private window and under a "block all cookies" setting, and a
 *  throw here would take the whole app down over a dismissed banner. */
export function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function writeDismissedVersion(version: string): void {
  try {
    window.localStorage.setItem(KEY, version)
  } catch {
    // Nothing to do and nothing worth saying: the pill still hides for this
    // session (the caller holds it in React state), it just comes back on the
    // next reload.
  }
}
