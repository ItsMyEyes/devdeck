import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PanelHeader } from './PanelHeader'
import type { PanelHeaderProps } from './PanelHeader'

afterEach(() => {
  cleanup()
})

const baseProps: PanelHeaderProps = {
  paneId: 'pane-1',
  tabs: [{ id: 'tab-1', label: 'Terminal' }],
  activeTabId: 'tab-1',
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onSplitRight: vi.fn(),
  onSplitDown: vi.fn(),
  onClose: vi.fn(),
}

describe('PanelHeader leadingContent', () => {
  it('renders leadingContent as the header\'s first child, before the tab strip', () => {
    const { container } = render(
      <PanelHeader {...baseProps} leadingContent={<button aria-label="Toggle sidebar">T</button>} />,
    )
    const header = container.firstElementChild as HTMLElement
    const leading = screen.getByRole('button', { name: 'Toggle sidebar' })

    expect(header.children[0]).toBe(leading)
    expect(header.children[1]?.textContent).toContain('Terminal')
  })

  it('omits the leading slot entirely when leadingContent is absent', () => {
    const { container } = render(<PanelHeader {...baseProps} />)
    const header = container.firstElementChild as HTMLElement

    expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull()
    // structure unchanged: no empty wrapper takes the leading slot — the tab
    // strip is still the header's first child.
    expect(header.children[0]?.textContent).toContain('Terminal')
  })
})
