import { useCallback, useEffect, useState } from 'react'

export const AUTO_SAVE_STORAGE_KEY = 'devdeck.editor.autoSave'

const listeners = new Set<(next: boolean) => void>()

/** Defaults to ON. The failure this setting exists to prevent is "I closed the
 *  tab and my edit was gone", so the safe default is the one that writes: only
 *  an explicit 'false' — the operator having turned it off — opts back into
 *  manual saves. That also means a malformed value keeps auto-save rather than
 *  silently reintroducing the data loss. */
export function readAutoSave(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setAutoSave(next: boolean) {
  try {
    window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, String(next))
  } catch {
    // A private-mode / quota failure must not stop the toggle taking effect for
    // this session, so the listeners still fire below.
  }
  for (const listener of listeners) listener(next)
}

export function subscribeAutoSave(listener: (next: boolean) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every open file tab subscribes, so flipping the switch arms or disarms all
 *  of them at once. Same in-process fan-out as `useVsCodeMode`, and for the same
 *  reason: the `storage` event only fires in *other* browser tabs, never the one
 *  that wrote the value. */
export function useAutoSaveSetting(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(readAutoSave)
  useEffect(() => subscribeAutoSave(setEnabled), [])
  return [enabled, useCallback((next: boolean) => setAutoSave(next), [])]
}
