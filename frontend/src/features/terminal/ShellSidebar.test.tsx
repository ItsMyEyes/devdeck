import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { FilesTarget } from './filesTarget'
import { ShellSidebar } from './ShellSidebar'

// TerminalExplorer/GitPanel pull in react-query + live network calls that are
// out of scope for ShellSidebar's own behaviour (rail gating, hide-not-unmount,
// drag strip) — stub them, and count mounts to prove a hidden subtree is
// never torn down and rebuilt.
let explorerMounts = 0
vi.mock('./TerminalExplorer', () => ({
  TerminalExplorer: (props: { rootLabel: string }) => {
    useEffect(() => {
      explorerMounts += 1
    }, [])
    return <div data-testid="mock-explorer">{props.rootLabel}</div>
  },
}))

vi.mock('./GitPanel', () => ({
  GitPanel: (props: {
    worktreeId: string
    active: boolean
    compact?: boolean
    onOpenDiff?: (target: { path: string; staged: boolean; untracked: boolean }) => void
  }) => (
    <div
      data-testid="mock-git"
      data-active={String(props.active)}
      data-compact={String(Boolean(props.compact))}
      onClick={() => props.onOpenDiff?.({ path: 'src/root.go', staged: false, untracked: false })}
    >
      {props.worktreeId}
    </div>
  ),
}))

// SessionsPanel calls useAgentThreads (react-query) internally — stub it the
// same way GitPanel is stubbed above, since this file has no
// QueryClientProvider in its render tree.
vi.mock('@/features/agent-chat/SessionsPanel', () => ({
  SessionsPanel: (props: {
    worktreeId: string
    activeThreadKey?: string
    onSelectThread?: (threadKey: string) => void
  }) => (
    <div data-testid="mock-sessions" data-active-thread={props.activeThreadKey ?? ''} onClick={() => props.onSelectThread?.('wt-1::chat-2')}>
      {props.worktreeId}
    </div>
  ),
}))

// jsdom has no PointerEvent / pointer-capture implementation at all — stub
// both so the drag strip's pointerdown/move/up handlers don't throw.
if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
    }
  }
  // @ts-expect-error jsdom doesn't implement PointerEvent
  window.PointerEvent = FakePointerEvent
}
// jsdom's Element has no real implementation to guard for — stub unconditionally.
Element.prototype.setPointerCapture = vi.fn()
Element.prototype.releasePointerCapture = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)

afterEach(() => {
  cleanup()
  explorerMounts = 0
  useDevDeckStore.setState({ shellSidebars: {} })
})

beforeEach(() => {
  useDevDeckStore.setState({ shellSidebars: {} })
})

const target: FilesTarget = { kind: 'ssh', connectionId: 'conn-1' }

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

const baseProps = {
  shellKey: 'wt:worktree-1',
  target,
  rootLabel: 'my-repo',
  onOpenFile: vi.fn(),
  onFileDeleted: vi.fn(),
  onRequestQuickOpen: vi.fn(),
  onRequestContentSearch: vi.fn(),
}

describe('ShellSidebar panel switcher', () => {
  // Without git there is only one panel, so a switcher would be dead chrome —
  // the Explorer still renders, it just has no button to switch to itself.
  it('renders no switcher at all when no git prop is given', () => {
    render(<ShellSidebar {...baseProps} />)

    expect(screen.queryByRole('button', { name: 'Explorer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull()
    expect(screen.getByTestId('mock-explorer')).toBeInTheDocument()
  })

  it('shows all three entries when a git prop is given', () => {
    render(<ShellSidebar {...baseProps} git={{ worktreeId: 'wt-1', machine }} />)

    expect(screen.getByRole('button', { name: 'Explorer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Git' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument()
  })

  // The sidebar is ~280px; a side-by-side diff there is unreadable, so its
  // GitPanel is list-only and hands the diff to the full-width in-pane tab.
  it('mounts its GitPanel in compact mode and forwards the open-diff callback', () => {
    const onOpenGitDiff = vi.fn()
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'git', width: 280 } } })
    render(<ShellSidebar {...baseProps} git={{ worktreeId: 'wt-1', machine }} onOpenGitDiff={onOpenGitDiff} />)

    const git = screen.getByTestId('mock-git')
    expect(git).toHaveAttribute('data-compact', 'true')

    fireEvent.click(git)
    expect(onOpenGitDiff).toHaveBeenCalledWith({ path: 'src/root.go', staged: false, untracked: false })
  })

  it('mounts SessionsPanel and forwards activeThreadKey / onOpenThread', () => {
    const onOpenThread = vi.fn()
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'sessions', width: 280 } } })
    render(
      <ShellSidebar
        {...baseProps}
        git={{ worktreeId: 'wt-1', machine }}
        activeThreadKey="wt-1"
        onOpenThread={onOpenThread}
      />,
    )

    const sessions = screen.getByTestId('mock-sessions')
    expect(sessions).toHaveAttribute('data-active-thread', 'wt-1')

    fireEvent.click(sessions)
    expect(onOpenThread).toHaveBeenCalledWith('wt-1::chat-2')
  })

  // A shell with no git support (or a stale persisted 'sessions' value) has
  // nowhere to fetch sessions from — same fallback as the existing 'git' guard.
  it('falls back to explorer when the panel is sessions but there is no git prop', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'sessions', width: 280 } } })
    render(<ShellSidebar {...baseProps} />)

    expect(screen.queryByTestId('mock-sessions')).toBeNull()
    expect(screen.getByTestId('mock-explorer')).toBeInTheDocument()
  })
})

describe('ShellSidebar close/hide behaviour', () => {
  it('hides with display:none instead of unmounting the explorer subtree', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'explorer', width: 280 } } })
    const { container } = render(<ShellSidebar {...baseProps} />)

    const root = container.firstElementChild as HTMLElement
    const explorerNode = screen.getByTestId('mock-explorer')
    expect(explorerMounts).toBe(1)
    expect(root).not.toHaveStyle({ display: 'none' })

    act(() => {
      useDevDeckStore.getState().setShellSidebarOpen('wt:worktree-1', false)
    })

    // still in the document, same node, hidden rather than gone.
    expect(root).toHaveStyle({ display: 'none' })
    expect(screen.getByTestId('mock-explorer')).toBe(explorerNode)
    expect(explorerNode).toBeInTheDocument()
    expect(explorerMounts).toBe(1)

    act(() => {
      useDevDeckStore.getState().setShellSidebarOpen('wt:worktree-1', true)
    })

    expect(root).not.toHaveStyle({ display: 'none' })
    expect(screen.getByTestId('mock-explorer')).toBe(explorerNode)
    expect(explorerMounts).toBe(1)
  })
})

describe('ShellSidebar drag strip', () => {
  it('clamps width at the 200px floor while dragging', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'explorer', width: 280 } } })
    render(<ShellSidebar {...baseProps} />)
    const strip = screen.getByRole('separator')

    fireEvent.pointerDown(strip, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(strip, { clientX: -10_000, pointerId: 1 })

    expect(useDevDeckStore.getState().shellSidebars['wt:worktree-1']?.width).toBe(200)
  })

  it('clamps width at the 560px ceiling while dragging', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'explorer', width: 280 } } })
    render(<ShellSidebar {...baseProps} />)
    const strip = screen.getByRole('separator')

    fireEvent.pointerDown(strip, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(strip, { clientX: 10_000, pointerId: 1 })

    expect(useDevDeckStore.getState().shellSidebars['wt:worktree-1']?.width).toBe(560)
  })

  it('passes an in-range drag width through unchanged', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'explorer', width: 280 } } })
    render(<ShellSidebar {...baseProps} />)
    const strip = screen.getByRole('separator')

    fireEvent.pointerDown(strip, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(strip, { clientX: 340, pointerId: 1 })

    expect(useDevDeckStore.getState().shellSidebars['wt:worktree-1']?.width).toBe(320)
  })

  it('resets width to the 280px default on dblclick', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:worktree-1': { open: true, panel: 'explorer', width: 450 } } })
    render(<ShellSidebar {...baseProps} />)
    const strip = screen.getByRole('separator')

    fireEvent.doubleClick(strip)

    expect(useDevDeckStore.getState().shellSidebars['wt:worktree-1']?.width).toBe(280)
  })
})
