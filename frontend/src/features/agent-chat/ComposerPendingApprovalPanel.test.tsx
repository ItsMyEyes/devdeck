import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerPendingApprovalPanel } from '@/features/agent-chat/ComposerPendingApprovalPanel'
import type { PendingApproval } from '@/features/agent-chat/types'

afterEach(() => cleanup())

const approval: PendingApproval = {
  requestId: 'req-1', createdAt: 1, requestType: 'command_execution_approval',
  detail: 'rm -rf /tmp/x', options: ['accept', 'decline', 'cancel'],
}

describe('ComposerPendingApprovalPanel', () => {
  it('renders nothing when there is no pending approval', () => {
    const { container } = render(<ComposerPendingApprovalPanel pendingApprovals={[]} onRespondToApproval={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the summary, detail, and an n/m counter when more than one is pending', () => {
    render(<ComposerPendingApprovalPanel pendingApprovals={[approval, { ...approval, requestId: 'req-2' }]} onRespondToApproval={vi.fn()} />)
    expect(screen.getByText('Command approval requested')).toBeInTheDocument()
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })
})

// ── the two mode buttons ─────────────────────────────────────────────────────
//
// Every other button on this card decides ONE request. These set the thread's
// standing permission mode, and the backend then re-runs that mode against
// whatever is already waiting (approval.Gate.ReleasePending) — which is what
// makes "switch to full access" a way out of a prompt rather than a setting
// that only takes effect on the next command.
describe('ComposerPendingApprovalPanel — permission mode buttons', () => {
  it('offers both modes when neither is the thread’s current one', () => {
    render(
      <ComposerPendingApprovalPanel
        pendingApprovals={[approval]}
        onRespondToApproval={vi.fn()}
        runtimeMode="approval-required"
        onChangeRuntimeMode={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Change mode auto' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change mode fullaccess' })).toBeInTheDocument()
  })

  it('dispatches the picked mode, not a decision on the request', async () => {
    const onChangeRuntimeMode = vi.fn()
    const onRespondToApproval = vi.fn()
    render(
      <ComposerPendingApprovalPanel
        pendingApprovals={[approval]}
        onRespondToApproval={onRespondToApproval}
        runtimeMode="approval-required"
        onChangeRuntimeMode={onChangeRuntimeMode}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Change mode fullaccess' }))
    expect(onChangeRuntimeMode).toHaveBeenCalledWith('full-access')
    // The card is answered by the BACKEND re-running the matrix, not by the
    // button faking a click on Approve — otherwise a mode the gate declined to
    // release (auto, with a write pending) would run the command anyway.
    expect(onRespondToApproval).not.toHaveBeenCalled()
  })

  it('drops the button for the mode already in force rather than offering a no-op', () => {
    render(
      <ComposerPendingApprovalPanel
        pendingApprovals={[approval]}
        onRespondToApproval={vi.fn()}
        runtimeMode="auto"
        onChangeRuntimeMode={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Change mode auto' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change mode fullaccess' })).toBeInTheDocument()
  })

  // Both props are optional so every pre-existing caller and test keeps
  // rendering the four decision buttons unchanged.
  it('renders no mode row at all when no dispatcher is supplied', () => {
    render(<ComposerPendingApprovalPanel pendingApprovals={[approval]} onRespondToApproval={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Change mode/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeInTheDocument()
  })
})
