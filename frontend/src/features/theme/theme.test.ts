import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, readThemePreference, resolveTheme, setThemePreference, THEME_STORAGE_KEY } from './theme'

beforeEach(() => {
  window.localStorage.clear()
})

describe('readThemePreference', () => {
  // Light mode is disabled: no matter what is stored, the app only ever
  // resolves to dark.
  it('always returns dark, regardless of what is stored', () => {
    expect(readThemePreference()).toBe('dark')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readThemePreference()).toBe('dark')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    expect(readThemePreference()).toBe('dark')
  })
})

describe('setThemePreference', () => {
  it('is a no-op: the preference cannot change while light mode is disabled', () => {
    setThemePreference('light')
    expect(readThemePreference()).toBe('dark')
  })
})

describe('resolveTheme', () => {
  it('always resolves to dark, regardless of preference or OS', () => {
    expect(resolveTheme('light', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('always applies dark, regardless of the argument', () => {
    const root = document.createElement('html')

    applyTheme('light', root)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.style.colorScheme).toBe('dark')

    applyTheme('dark', root)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.style.colorScheme).toBe('dark')
  })
})
