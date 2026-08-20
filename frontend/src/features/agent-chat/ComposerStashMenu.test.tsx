import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerStashMenu } from '@/features/agent-chat/ComposerStashMenu'
import type { PromptStashEntry } from '@/features/agent-chat/promptStash'

afterEach(() => cleanup())

function makeEntry(id: string, text: string, createdAt = new Date().toISOString()): PromptStashEntry {
  return { id, createdAt, text }
}

function deleteButtonFor(id: string) {
  return screen.getByTestId(`composer-stash-entry-${id}`).querySelector('button[aria-label="Delete stashed prompt"]')
}

describe('ComposerStashMenu', () => {
  it('renders entries in the given (newest-first) order, each with its snippet and relative time', () => {
    const entries = [
      makeEntry('newest', 'the newest stashed prompt'),
      makeEntry('oldest', 'the oldest stashed prompt', new Date(Date.now() - 60 * 60 * 1000).toISOString()),
    ]
    render(<ComposerStashMenu entries={entries} onSelect={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />)

    const rows = screen.getAllByTestId(/^composer-stash-entry-/)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('the newest stashed prompt')
    expect(rows[1]).toHaveTextContent('the oldest stashed prompt')
    expect(rows[1]).toHaveTextContent(/hour/i)
  })

  it('truncates a long entry through stashEntrySnippet, not the raw text', () => {
    const longText = `${'x'.repeat(120)}`
    render(
      <ComposerStashMenu entries={[makeEntry('a', longText)]} onSelect={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />,
    )

    expect(screen.getByTestId('composer-stash-entry-a')).toHaveTextContent(`${'x'.repeat(90)}…`)
    expect(screen.queryByText(longText)).not.toBeInTheDocument()
  })

  it('per-row delete calls onDelete with the entry id and does not also call onSelect', () => {
    const entries = [makeEntry('a', 'first')]
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(<ComposerStashMenu entries={entries} onSelect={onSelect} onDelete={onDelete} onClose={vi.fn()} />)

    const button = deleteButtonFor('a')
    expect(button).not.toBeNull()
    fireEvent.click(button as Element)

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('a')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('clicking a row (not its delete button) calls onSelect with that entry id', () => {
    const entries = [makeEntry('a', 'first'), makeEntry('b', 'second')]
    const onSelect = vi.fn()
    render(<ComposerStashMenu entries={entries} onSelect={onSelect} onDelete={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('composer-stash-entry-b'))

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('starts with the first (newest) entry highlighted', () => {
    const entries = [makeEntry('a', 'a'), makeEntry('b', 'b')]
    render(<ComposerStashMenu entries={entries} onSelect={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('composer-stash-entry-a')).toHaveAttribute('data-highlighted', 'true')
    expect(screen.getByTestId('composer-stash-entry-b')).toHaveAttribute('data-highlighted', 'false')
  })

  it('ArrowDown/ArrowUp move the highlighted row, wrapping past either end', () => {
    const entries = [makeEntry('a', 'a'), makeEntry('b', 'b'), makeEntry('c', 'c')]
    render(<ComposerStashMenu entries={entries} onSelect={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-stash-entry-b')).toHaveAttribute('data-highlighted', 'true')

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-stash-entry-c')).toHaveAttribute('data-highlighted', 'true')

    // wraps forward past the last entry back to the first
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-stash-entry-a')).toHaveAttribute('data-highlighted', 'true')

    // wraps backward past the first entry to the last
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(screen.getByTestId('composer-stash-entry-c')).toHaveAttribute('data-highlighted', 'true')
  })

  it('Enter selects the highlighted entry', () => {
    const entries = [makeEntry('a', 'a'), makeEntry('b', 'b')]
    const onSelect = vi.fn()
    render(<ComposerStashMenu entries={entries} onSelect={onSelect} onDelete={vi.fn()} onClose={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('Escape calls onClose', () => {
    const onClose = vi.fn()
    render(<ComposerStashMenu entries={[makeEntry('a', 'a')]} onSelect={vi.fn()} onDelete={vi.fn()} onClose={onClose} />)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cmd+Backspace deletes the highlighted entry', () => {
    const entries = [makeEntry('a', 'a'), makeEntry('b', 'b')]
    const onDelete = vi.fn()
    render(<ComposerStashMenu entries={entries} onSelect={vi.fn()} onDelete={onDelete} onClose={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Backspace', metaKey: true })

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('Ctrl+Backspace also deletes the highlighted entry', () => {
    const onDelete = vi.fn()
    render(<ComposerStashMenu entries={[makeEntry('a', 'a')]} onSelect={vi.fn()} onDelete={onDelete} onClose={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Backspace', ctrlKey: true })

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('plain Backspace (no modifier) does not delete', () => {
    const onDelete = vi.fn()
    render(<ComposerStashMenu entries={[makeEntry('a', 'a')]} onSelect={vi.fn()} onDelete={onDelete} onClose={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Backspace' })

    expect(onDelete).not.toHaveBeenCalled()
  })

  it('binds all keyboard handling capture-phase on window: a keydown dispatched on document.body (outside the menu) still fires it', () => {
    const onClose = vi.fn()
    render(<ComposerStashMenu entries={[makeEntry('a', 'a')]} onSelect={vi.fn()} onDelete={vi.fn()} onClose={onClose} />)

    // document.body is the RTL render container's parent, not a node inside
    // the menu itself — this only fires if the listener lives on `window`.
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('removes its window keydown listener on unmount', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <ComposerStashMenu entries={[makeEntry('a', 'a')]} onSelect={vi.fn()} onDelete={vi.fn()} onClose={onClose} />,
    )
    unmount()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
