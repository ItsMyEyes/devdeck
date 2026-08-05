import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserTabStrip } from '@/features/browser/BrowserTabStrip'
import type { BrowserDocState } from '@/store/useDevDeckStore'

afterEach(() => {
  cleanup()
})

function makeDoc(id: string, title: string): BrowserDocState {
  return { id, machineId: null, proxy: null, url: `https://${id}.example.com`, title, loading: false, loadError: null, history: [], historyIndex: -1 }
}

describe('BrowserTabStrip close control', () => {
  it('is keyboard focusable', () => {
    const docs = [makeDoc('a', 'Doc A'), makeDoc('b', 'Doc B')]
    render(<BrowserTabStrip docs={docs} activeDocId="a" onSelect={vi.fn()} onClose={vi.fn()} />)

    const close = screen.getByRole('button', { name: 'Close Doc A' })
    expect(close.tabIndex).toBe(0)
  })

  it('closes the doc on Enter without selecting it', () => {
    const docs = [makeDoc('a', 'Doc A'), makeDoc('b', 'Doc B')]
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<BrowserTabStrip docs={docs} activeDocId="a" onSelect={onSelect} onClose={onClose} />)

    const close = screen.getByRole('button', { name: 'Close Doc A' })
    fireEvent.keyDown(close, { key: 'Enter' })

    expect(onClose).toHaveBeenCalledWith('a')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes the doc on Space without selecting it', () => {
    const docs = [makeDoc('a', 'Doc A'), makeDoc('b', 'Doc B')]
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<BrowserTabStrip docs={docs} activeDocId="a" onSelect={onSelect} onClose={onClose} />)

    const close = screen.getByRole('button', { name: 'Close Doc A' })
    fireEvent.keyDown(close, { key: ' ' })

    expect(onClose).toHaveBeenCalledWith('a')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('ignores unrelated keys', () => {
    const docs = [makeDoc('a', 'Doc A'), makeDoc('b', 'Doc B')]
    const onClose = vi.fn()
    render(<BrowserTabStrip docs={docs} activeDocId="a" onSelect={vi.fn()} onClose={onClose} />)

    const close = screen.getByRole('button', { name: 'Close Doc A' })
    fireEvent.keyDown(close, { key: 'Tab' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
