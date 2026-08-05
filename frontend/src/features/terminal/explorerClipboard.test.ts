import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearExplorerClipboard,
  getExplorerClipboard,
  resolvePasteRoute,
  setExplorerClipboard,
  subscribeExplorerClipboard,
  type ExplorerClipboard,
} from './explorerClipboard'

function entry(overrides: Partial<ExplorerClipboard> = {}): ExplorerClipboard {
  return { shellKey: 'wt:a', paths: ['src/a.ts'], hasDir: false, mode: 'copy', ...overrides }
}

afterEach(() => clearExplorerClipboard())

describe('shared clipboard', () => {
  it('holds entries across independent readers', () => {
    setExplorerClipboard(entry())
    expect(getExplorerClipboard()).toEqual(entry())
  })

  // The whole reason this is module-level rather than component state: a copy
  // in one pane has to light up Paste in every other mounted pane.
  it('notifies every subscriber when any tree copies', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribeExplorerClipboard(a)
    const unsubB = subscribeExplorerClipboard(b)
    setExplorerClipboard(entry())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    setExplorerClipboard(entry({ mode: 'cut' }))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    unsubB()
  })

  it('stops notifying after unsubscribe', () => {
    const spy = vi.fn()
    subscribeExplorerClipboard(spy)()
    setExplorerClipboard(entry())
    expect(spy).not.toHaveBeenCalled()
  })

  it('clears to null', () => {
    setExplorerClipboard(entry())
    clearExplorerClipboard()
    expect(getExplorerClipboard()).toBeNull()
  })
})

describe('resolvePasteRoute', () => {
  it('moves a cut pasted back into its own shell', () => {
    expect(resolvePasteRoute(entry({ mode: 'cut' }), 'wt:a')).toBe('move')
  })

  it('copies a copy pasted into its own shell', () => {
    expect(resolvePasteRoute(entry({ mode: 'copy' }), 'wt:a')).toBe('copy')
  })

  it('transfers anything pasted into a different shell', () => {
    expect(resolvePasteRoute(entry({ mode: 'copy' }), 'ssh:b')).toBe('transfer')
  })

  // Deleting the source after an unverified write on another machine is how a
  // transfer becomes data loss, so a cut does NOT move across a shell boundary.
  it('does not move a cut across a shell boundary', () => {
    expect(resolvePasteRoute(entry({ mode: 'cut' }), 'ssh:b')).toBe('transfer')
  })
})
