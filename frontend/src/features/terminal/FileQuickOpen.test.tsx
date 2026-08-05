import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/** Every pattern the panel has searched for, in order — this is what proves the
 *  `:line:column` suffix never reaches the backend as part of the filename. */
const searched: string[] = []
let results: string[] = []

vi.mock('@/features/data/queries', () => ({
  useFileSearchTarget: (_target: unknown, pattern: string) => {
    searched.push(pattern)
    return { data: results, isFetching: false, error: null }
  },
}))

vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({
  useNativeOverlayBlocker: () => {},
}))

const { FileQuickOpen } = await import('./FileQuickOpen')

function renderPanel(onOpenFile = vi.fn()) {
  render(
    <FileQuickOpen
      open
      target={{ kind: 'ssh', connectionId: 'c1' }}
      onClose={vi.fn()}
      onOpenFile={onOpenFile}
    />,
  )
  return onOpenFile
}

/** `pattern` feeds a `useDeferredValue`, so the search below only sees the new
 *  text once React has flushed the deferred pass. */
function type(text: string) {
  act(() => {
    fireEvent.change(screen.getByLabelText('File or folder search'), { target: { value: text } })
  })
}

beforeEach(() => {
  searched.length = 0
  results = []
})

afterEach(() => {
  cleanup()
})

describe('FileQuickOpen path:line:column', () => {
  it('searches for the path without the location suffix', () => {
    results = ['src/App.tsx']
    renderPanel()

    type('src/App.tsx:123:23')

    expect(searched.at(-1)).toBe('src/App.tsx')
  })

  it('opens the chosen file at the typed line and column', () => {
    results = ['src/App.tsx']
    const onOpenFile = renderPanel()

    type('src/App.tsx:123:23')
    fireEvent.click(screen.getByText('App.tsx').closest('button')!)

    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx', { line: 123, column: 23 })
  })

  it('opens at the line alone when no column is given', () => {
    results = ['main.go']
    const onOpenFile = renderPanel()

    type('main.go:42')
    fireEvent.click(screen.getByText('main.go').closest('button')!)

    expect(onOpenFile).toHaveBeenCalledWith('main.go', { line: 42 })
  })

  it('passes no location for an ordinary path', () => {
    results = ['main.go']
    const onOpenFile = renderPanel()

    type('main.go')
    fireEvent.click(screen.getByText('main.go').closest('button')!)

    expect(onOpenFile).toHaveBeenCalledWith('main.go', undefined)
  })

  // Enter is the keyboard path users actually reach for after pasting a
  // `file:line:col` from a stack trace, and it goes through the same `choose`.
  it('carries the location through the Enter shortcut', () => {
    results = ['main.go']
    const onOpenFile = renderPanel()

    type('main.go:42:7')
    fireEvent.keyDown(screen.getByLabelText('File or folder search'), { key: 'Enter' })

    expect(onOpenFile).toHaveBeenCalledWith('main.go', { line: 42, column: 7 })
  })

  it('shows the parsed location back to the user', () => {
    results = ['main.go']
    renderPanel()

    type('main.go:42:7')

    expect(screen.getByLabelText('Opens at line 42, column 7')).toHaveTextContent(':42:7')
  })

  it('keeps searching the whole text while the suffix is still being typed', () => {
    results = ['main.go']
    renderPanel()

    type('main.go:')

    expect(searched.at(-1)).toBe('main.go:')
    expect(screen.queryByLabelText(/^Opens at line/)).not.toBeInTheDocument()
  })
})
