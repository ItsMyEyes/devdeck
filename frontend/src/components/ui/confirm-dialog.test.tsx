/**
 * The regression this component exists for: `window.confirm` is a silent
 * no-op in the Tauri desktop build. Its WKWebView implements no
 * `runJavaScriptConfirmPanelWithMessage` delegate, so `confirm()` returns
 * `false` immediately with no dialog ever shown — and every caller written as
 * `if (!window.confirm(...)) return` therefore returns early, always. The
 * action simply never happens, with no error and nothing on screen.
 *
 * `TerminalExplorer.tsx` already documents the identical defect for
 * `window.prompt` and its `runJavaScriptTextInputPanelWithPrompt` delegate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

afterEach(cleanup)

describe('ConfirmDialog', () => {
  it('runs the action when confirmed', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Delete this session?"
        description="Its whole transcript goes with it."
        confirmLabel="Delete session"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not run the action when cancelled', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Delete this session?"
        confirmLabel="Delete session"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    // Base UI hands `onOpenChange` an event and a reason alongside the flag,
    // so assert the flag rather than the whole argument list.
    expect(onOpenChange).toHaveBeenCalled()
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false)
  })

  // A destructive action that fires twice is worse than one that fires never —
  // the second delete hits an id that no longer exists.
  it('blocks the action while it is already running', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        pending
        title="Delete this session?"
        confirmLabel="Delete session"
        pendingLabel="Deleting…"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    const confirm = screen.getByRole('button', { name: 'Deleting…' })
    expect(confirm).toBeDisabled()
    await userEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing while closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Delete this session?"
        confirmLabel="Delete session"
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.queryByText('Delete this session?')).not.toBeInTheDocument()
  })
})
