/**
 * Plan T2 — chip node view (presentational). One component serves all three
 * chip kinds; the only per-kind differences are the icon and the label. The
 * remove control renders INSIDE the component — never portalled out, since a
 * ProseMirror node view's DOM is the only DOM `posAtCoords` can resolve back
 * into a document position (see the spec's §5 and the notion editor's
 * gutter regression this repo already hit).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ComposerChip } from '@/features/agent-chat/ComposerChip'

afterEach(() => {
  cleanup()
})

describe('ComposerChip', () => {
  it('renders the label for a file chip', () => {
    render(<ComposerChip kind="file" label="src/app.tsx" onRemove={vi.fn()} />)
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
  })

  it('renders the label for a skill chip', () => {
    render(<ComposerChip kind="skill" label="code-review" onRemove={vi.fn()} />)
    expect(screen.getByText('code-review')).toBeInTheDocument()
  })

  it('renders the label for a terminal-context chip', () => {
    render(<ComposerChip kind="terminal-context" label="Terminal 1:12-34" onRemove={vi.fn()} />)
    expect(screen.getByText('Terminal 1:12-34')).toBeInTheDocument()
  })

  it('renders a distinct icon per kind — no two kinds share markup', () => {
    const { container: fileContainer } = render(
      <ComposerChip kind="file" label="a" onRemove={vi.fn()} />,
    )
    const { container: skillContainer } = render(
      <ComposerChip kind="skill" label="a" onRemove={vi.fn()} />,
    )
    const { container: terminalContainer } = render(
      <ComposerChip kind="terminal-context" label="a" onRemove={vi.fn()} />,
    )

    const fileIcon = fileContainer.querySelector('[data-chip-icon]')
    const skillIcon = skillContainer.querySelector('[data-chip-icon]')
    const terminalIcon = terminalContainer.querySelector('[data-chip-icon]')

    expect(fileIcon).not.toBeNull()
    expect(skillIcon).not.toBeNull()
    expect(terminalIcon).not.toBeNull()

    const fileIconName = fileIcon?.getAttribute('data-chip-icon')
    const skillIconName = skillIcon?.getAttribute('data-chip-icon')
    const terminalIconName = terminalIcon?.getAttribute('data-chip-icon')

    expect(fileIconName).toBeTruthy()
    expect(skillIconName).toBeTruthy()
    expect(terminalIconName).toBeTruthy()
    expect(new Set([fileIconName, skillIconName, terminalIconName]).size).toBe(3)
  })

  it('calls onRemove when the remove button is clicked, and the button renders inside the chip', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const { container } = render(<ComposerChip kind="file" label="src/app.tsx" onRemove={onRemove} />)

    const button = screen.getByRole('button', { name: /remove/i })
    expect(container).toContainElement(button)

    await user.click(button)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does not fire onRemove when the chip body itself is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<ComposerChip kind="file" label="src/app.tsx" onRemove={onRemove} />)

    await user.click(screen.getByText('src/app.tsx'))
    expect(onRemove).not.toHaveBeenCalled()
  })
})
