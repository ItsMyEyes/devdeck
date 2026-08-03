import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserOmnibox } from '@/features/browser/BrowserOmnibox'
import type { BrowserOmniboxProps } from '@/features/browser/BrowserOmnibox'

afterEach(() => {
  cleanup()
})

const URL = 'https://music.youtube.com/library'

function renderOmnibox(overrides: Partial<BrowserOmniboxProps> = {}) {
  const props: BrowserOmniboxProps = {
    docId: 'doc-1',
    url: URL,
    title: 'YouTube Music',
    machineId: 'machine-1',
    machines: [{ id: 'machine-1', name: 'home-laptop' } as BrowserOmniboxProps['machines'][number]],
    machineHealth: new Map(),
    onSelectMachine: vi.fn(),
    editing: false,
    onEditingChange: vi.fn(),
    onBookmark: vi.fn(),
    draft: URL,
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<BrowserOmnibox {...props} />) }
}

describe('BrowserOmnibox address editing', () => {
  // The address used to be edited in a floating card centred over the page.
  // It is now edited in the bar itself, so nothing overlays the tile — which
  // also means no native-webview occlusion blocker just to type a URL.
  it('edits in the bar rather than opening anything over the page', () => {
    const { props } = renderOmnibox({ editing: true })

    expect(screen.getByLabelText('Address')).toHaveValue(URL)
    expect(screen.queryByLabelText('Edit address')).not.toBeInTheDocument()
    expect(props.onEditingChange).not.toHaveBeenCalled()
  })

  it('turns the URL display into the input when it is clicked', () => {
    const { props } = renderOmnibox()

    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Edit address'))

    expect(props.onEditingChange).toHaveBeenCalledWith(true)
  })

  it('rolls the draft back to the live URL on Escape', () => {
    const { props } = renderOmnibox({ editing: true, draft: 'music.youtube.co' })

    fireEvent.keyDown(screen.getByLabelText('Address'), { key: 'Escape' })

    expect(props.onDraftChange).toHaveBeenCalledWith(URL)
    expect(props.onEditingChange).toHaveBeenCalledWith(false)
  })

  // Clicking the machine picker mid-edit blurs the input. Dropping the edit
  // state is right (the bar goes back to showing the address), discarding what
  // was typed is not — the operator is one click away from coming back to it.
  it('leaves the draft alone when the input loses focus', () => {
    const { props } = renderOmnibox({ editing: true, draft: 'music.youtube.co' })

    fireEvent.blur(screen.getByLabelText('Address'))

    expect(props.onEditingChange).toHaveBeenCalledWith(false)
    expect(props.onDraftChange).not.toHaveBeenCalled()
  })

  it('submits the trimmed draft', () => {
    const { props } = renderOmnibox({ editing: true, draft: '  music.youtube.com  ' })

    fireEvent.submit(screen.getByLabelText('Address'))

    expect(props.onSubmit).toHaveBeenCalledWith('music.youtube.com')
  })

  it('stays inline for a tab that has no address yet', () => {
    renderOmnibox({ url: '', draft: '', editing: false })

    expect(screen.getByLabelText('Address')).toBeInTheDocument()
    expect(screen.queryByLabelText('Edit address')).not.toBeInTheDocument()
  })
})
