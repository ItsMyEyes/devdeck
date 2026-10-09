import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, currentResolvedTheme, readThemePreference, resolveTheme, setThemePreference, subscribeResolvedTheme, subscribeThemePreference, THEME_STORAGE_KEY } from '@/features/theme/theme'

const cleanups: (() => void)[] = []
beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
})

describe('theme preference', () => {
  it('defaults to dark for missing or invalid preferences', () => {
    expect(readThemePreference()).toBe('dark')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'invalid')
    expect(readThemePreference()).toBe('dark')
  })
  it.each(['light', 'dark', 'system'] as const)('persists and reads %s', (preference) => {
    setThemePreference(preference)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(preference)
    expect(readThemePreference()).toBe(preference)
  })
  it('notifies local changes and stops after unsubscribe', () => {
    const values: string[] = []
    const unsubscribe = subscribeThemePreference((value) => values.push(value))
    cleanups.push(unsubscribe)
    setThemePreference('light')
    expect(values).toEqual(['light'])
    unsubscribe()
    setThemePreference('dark')
    expect(values).toEqual(['light'])
  })
  it('follows changes and clearing from another window', () => {
    const values: string[] = []
    cleanups.push(subscribeThemePreference((value) => values.push(value)))
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, storageArea: window.localStorage }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', storageArea: window.localStorage }))
    window.localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: window.localStorage }))
    expect(values).toEqual(['light', 'dark'])
  })
  it('switches for this session when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const values: string[] = []
    cleanups.push(subscribeThemePreference((value) => values.push(value)))
    expect(() => setThemePreference('light')).not.toThrow()
    expect(readThemePreference()).toBe('light')
    expect(values).toEqual(['light'])
    setThemePreference('dark')
  })
  it('switches when storage can be read but writes fail', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const blockedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    setThemePreference('light')
    expect(readThemePreference()).toBe('light')
    blockedWrite.mockRestore()
    setThemePreference('dark')
  })
})

describe('resolved theme', () => {
  it.each([
    ['light', true, 'light'], ['light', false, 'light'],
    ['dark', false, 'dark'], ['dark', true, 'dark'],
    ['system', false, 'light'], ['system', true, 'dark'],
  ] as const)('resolves %s with OS dark=%s to %s', (preference, dark, expected) => {
    expect(resolveTheme(preference, dark)).toBe(expected)
  })
  it('tracks OS changes only for system preference and cleans up', () => {
    const media = Object.assign(new EventTarget(), { matches: false })
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList)
    setThemePreference('system')
    expect(currentResolvedTheme()).toBe('light')
    const values: string[] = []
    const unsubscribe = subscribeResolvedTheme((value) => values.push(value))
    cleanups.push(unsubscribe)
    media.matches = true
    media.dispatchEvent(new Event('change'))
    setThemePreference('light')
    media.matches = false
    media.dispatchEvent(new Event('change'))
    expect(values).toEqual(['dark', 'light'])
    unsubscribe()
    setThemePreference('dark')
    expect(values).toEqual(['dark', 'light'])
  })
  it('keeps explicit preferences usable without matchMedia', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => { throw new Error('unavailable') })
    const values: string[] = []
    cleanups.push(subscribeResolvedTheme((value) => values.push(value)))
    setThemePreference('light')
    expect(currentResolvedTheme()).toBe('light')
    expect(values).toEqual(['light'])
  })
})

describe('applyTheme', () => {
  it('switches both palette classes and browser controls', () => {
    const root = document.createElement('html')
    root.classList.add('dark', 'other')
    applyTheme('light', root)
    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
    applyTheme('dark', root)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.classList.contains('other')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
  })
})
