import { useCallback, useEffect, useState } from 'react'

export const VSCODE_MODE_STORAGE_KEY = 'devdeck.editor.vscodeMode'

const listeners = new Set<(next: boolean) => void>()

export function readVsCodeMode(): boolean {
  try {
    return window.localStorage.getItem(VSCODE_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setVsCodeMode(next: boolean) {
  try {
    window.localStorage.setItem(VSCODE_MODE_STORAGE_KEY, String(next))
  } catch {
    // A private-mode / quota failure must not stop the toggle taking effect for
    // this session, so the listeners still fire below.
  }
  for (const listener of listeners) listener(next)
}

export function subscribeVsCodeMode(listener: (next: boolean) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every mounted editor subscribes, so flipping the setting calls
 *  `editor.updateOptions()` on each one — no remount, no lost undo history. */
export function useVsCodeMode(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(readVsCodeMode)
  useEffect(() => subscribeVsCodeMode(setEnabled), [])
  return [enabled, useCallback((next: boolean) => setVsCodeMode(next), [])]
}
