export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** Also used by the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = 'devdeck.appearance.theme'
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'
const THEME_CHANGE_EVENT = 'devdeck:theme-change'
// Keep switching usable in webviews that block localStorage.
let sessionPreference: ThemePreference | undefined

export function readThemePreference(): ThemePreference {
  if (sessionPreference !== undefined) return sessionPreference
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark'
  } catch {
    return 'dark'
  }
}

export function setThemePreference(next: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
    sessionPreference = undefined
  } catch {
    sessionPreference = next
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
}

export function subscribeThemePreference(listener: (preference: ThemePreference) => void) {
  const notify = () => listener(readThemePreference())
  const onStorage = (event: StorageEvent) => {
    if ((event.key === THEME_STORAGE_KEY || event.key === null) && event.storageArea === window.localStorage) {
      sessionPreference = undefined
      notify()
    }
  }
  window.addEventListener(THEME_CHANGE_EVENT, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches
  } catch {
    return true
  }
}

export function currentResolvedTheme(): ResolvedTheme {
  return resolveTheme(readThemePreference(), systemPrefersDark())
}

/** Shared by React surfaces and live SSH terminals. Each consumer owns its
 *  subscription, including cleanup of the OS preference listener. */
export function subscribeResolvedTheme(listener: (resolved: ResolvedTheme) => void): () => void {
  let previous = currentResolvedTheme()
  const notify = () => {
    const next = currentResolvedTheme()
    if (next === previous) return
    previous = next
    listener(next)
  }
  const unsubscribePreference = subscribeThemePreference(notify)
  let media: MediaQueryList | undefined
  try {
    media = window.matchMedia(SYSTEM_DARK_QUERY)
    media.addEventListener('change', notify)
  } catch {
    // Explicit choices remain usable without matchMedia.
  }
  return () => {
    unsubscribePreference()
    media?.removeEventListener('change', notify)
  }
}

/** Both Tailwind's dark variant and the raw light palette follow this class. */
export function applyTheme(resolved: ResolvedTheme = currentResolvedTheme(), root: HTMLElement = document.documentElement) {
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#1a1d1d')
}
