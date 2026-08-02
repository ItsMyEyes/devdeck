/** The slice of a browser doc's state that back/forward depends on. Kept as a
 *  standalone shape so the rules below can be exercised without a store, a
 *  webview, or Tauri. */
export interface HistoryState {
  history: string[]
  historyIndex: number
}

/**
 * Folds a committed page load into a doc's history.
 *
 * The native webview keeps its own session history, and DevDeck keeps this
 * shadow copy to drive the toolbar's enabled states. They used to diverge the
 * moment anyone clicked a link *inside* the page: the page-load event updated
 * the address bar but never touched `history`, so `historyIndex` stayed at 0,
 * `canGoBack` stayed false, and the back arrow never lit up.
 *
 * `initiated` distinguishes the two sources:
 *  - `true`  — DevDeck triggered this load (typed address, bookmark, or a
 *    toolbar back/forward step) and has already written the entry. The load
 *    only tells us which URL finally committed, which differs from what was
 *    recorded whenever the server redirected.
 *  - `false` — the webview navigated on its own (link click, SPA route, swipe
 *    gesture, mouse side-button), and the entry still has to be recorded.
 */
export function recordPageLoad(state: HistoryState, url: string, initiated: boolean): HistoryState {
  const { history, historyIndex } = state

  if (initiated) {
    if (historyIndex < 0 || historyIndex >= history.length) {
      return { history: [...history, url], historyIndex: history.length }
    }
    if (history[historyIndex] === url) return state
    const next = [...history]
    next[historyIndex] = url
    return { history: next, historyIndex }
  }

  if (history[historyIndex] === url) return state
  // The webview's own back/forward (swipe, side-button, a page calling
  // history.back()) lands on an entry we already hold — follow the index
  // instead of forking a new branch off it.
  if (historyIndex > 0 && history[historyIndex - 1] === url) {
    return { history, historyIndex: historyIndex - 1 }
  }
  if (historyIndex < history.length - 1 && history[historyIndex + 1] === url) {
    return { history, historyIndex: historyIndex + 1 }
  }

  const kept = history.slice(0, historyIndex + 1)
  return { history: [...kept, url], historyIndex: kept.length }
}
