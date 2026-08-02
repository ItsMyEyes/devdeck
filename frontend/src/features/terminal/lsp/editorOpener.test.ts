import { describe, expect, it, vi } from 'vitest'
import { createEditorOpener } from './editorOpener'

const pathFromUri = (uri: string) =>
  uri.startsWith('file:///root/') ? uri.slice('file:///root/'.length) : null

describe('createEditorOpener', () => {
  it('opens an in-worktree uri as a DevDeck tab and claims the navigation', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    const handled = opener('file:///root/src/main.go', {
      startLineNumber: 4,
      startColumn: 2,
      endLineNumber: 4,
      endColumn: 9,
    })
    expect(handled).toBe(true)
    expect(openPath).toHaveBeenCalledWith('src/main.go', {
      startLine: 4,
      startColumn: 2,
      endLine: 4,
      endColumn: 9,
    })
  })

  it('opens without a reveal when monaco supplies no range', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    expect(opener('file:///root/a.ts')).toBe(true)
    expect(openPath).toHaveBeenCalledWith('a.ts', undefined)
  })

  it('declines a uri outside the worktree so monaco can fall back', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    expect(opener('file:///elsewhere/x.go')).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })
})
