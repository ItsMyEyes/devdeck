import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VSCODE_MODE_STORAGE_KEY,
  readVsCodeMode,
  setVsCodeMode,
  subscribeVsCodeMode,
} from './useVsCodeMode'

describe('vscode mode pref', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to off when nothing is stored', () => {
    expect(readVsCodeMode()).toBe(false)
  })

  it('round-trips through localStorage', () => {
    setVsCodeMode(true)
    expect(localStorage.getItem(VSCODE_MODE_STORAGE_KEY)).toBe('true')
    expect(readVsCodeMode()).toBe(true)
  })

  it('treats a malformed value as off rather than throwing', () => {
    localStorage.setItem(VSCODE_MODE_STORAGE_KEY, '{not json')
    expect(readVsCodeMode()).toBe(false)
  })

  it('notifies subscribers so open editors update live', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeVsCodeMode(listener)
    setVsCodeMode(true)
    expect(listener).toHaveBeenCalledWith(true)
    unsubscribe()
    setVsCodeMode(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
