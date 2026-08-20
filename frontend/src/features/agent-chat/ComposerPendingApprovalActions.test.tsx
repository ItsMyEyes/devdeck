import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerPendingApprovalActions } from '@/features/agent-chat/ComposerPendingApprovalActions'

afterEach(() => cleanup())

describe('ComposerPendingApprovalActions', () => {
  it('renders Cancel, Decline, Approve, and Always-allow when acceptForSession is offered', () => {
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'acceptForSession', 'decline', 'cancel']} onRespond={vi.fn()} />)
    expect(screen.getByText('Cancel turn')).toBeInTheDocument()
    expect(screen.getByText('Decline')).toBeInTheDocument()
    expect(screen.getByText('Always allow this session')).toBeInTheDocument()
    expect(screen.getByText('Approve once')).toBeInTheDocument()
  })

  it('omits Always-allow when acceptForSession is not in options', () => {
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'decline', 'cancel']} onRespond={vi.fn()} />)
    expect(screen.queryByText('Always allow this session')).not.toBeInTheDocument()
  })

  it('clicking Approve once calls onRespond with accept', () => {
    const onRespond = vi.fn()
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'decline', 'cancel']} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Approve once'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'accept')
  })
})
