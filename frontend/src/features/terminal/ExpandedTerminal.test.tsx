import { forwardRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine, Project, Worktree } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { ExpandedTerminal } from './ExpandedTerminal'
import { createDefaultLayout, createExplorerContent, splitLeaf } from './paneTree'
import type { ShellSidebarProps } from './ShellSidebar'

/**
 * Covers spec §2 (ShellSidebar mount site), §4 (the sidebar toggle button,
 * rendered only on the first leaf), and §5 (Cmd/Ctrl+B) for the worktree
 * pane — see docs/superpowers/specs/2026-08-04-sidebar-shell-explorer-design.md.
 * Every heavy leaf renderer (Terminal/GitPanel/TerminalExplorer/FileEditor/...)
 * and ShellSidebar itself are stubbed, the same way ShellSidebar.test.tsx stubs
 * TerminalExplorer/GitPanel — this file is about ExpandedTerminal's own wiring,
 * not those components' internals.
 */

// jsdom implements no layout at all, so `offsetParent` is always `null` —
// the keydown handler's "is this tab actually the one on screen" guard
// (`containerRef.current?.offsetParent === null`) would bail unconditionally
// without this, regardless of `isFocused`. This approximates "visible unless
// an ancestor is display:none", which is all the guard needs.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    return this.parentElement
  },
})

// useIsDesktop() reads window.matchMedia, unimplemented in jsdom.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

let shellSidebarCalls: ShellSidebarProps[] = []
vi.mock('./ShellSidebar', () => ({
  ShellSidebar: (props: ShellSidebarProps) => {
    shellSidebarCalls.push(props)
    return <div data-testid="shell-sidebar-stub">{props.shellKey}</div>
  },
}))

vi.mock('./Terminal', () => ({
  Terminal: forwardRef((_props: unknown, _ref: unknown) => <div data-testid="terminal-stub" />),
}))

// A fresh worktree now defaults to an agent-chat primary pane (spec decision
// 1), so every test in this file renders one whether it cares or not. Stub
// it the same way Terminal/GitPanel/TerminalExplorer are stubbed below —
// this file is about ExpandedTerminal's own pane/tab wiring, not the chat
// pane's internals (covered by AgentChatPane.test.tsx), and the real
// component would otherwise open a live WebSocket via useAgentChatSocket.
vi.mock('@/features/agent-chat/AgentChatPane', () => ({
  AgentChatPane: () => <div data-testid="agent-chat-stub" />,
}))

vi.mock('./GitPanel', () => ({
  GitPanel: () => <div data-testid="git-panel-stub" />,
}))

let terminalExplorerCalls: Array<Record<string, unknown>> = []
vi.mock('./TerminalExplorer', () => ({
  TerminalExplorer: (props: Record<string, unknown>) => {
    terminalExplorerCalls.push(props)
    return <div data-testid="terminal-explorer-stub" />
  },
}))

vi.mock('./FileEditor', () => ({
  FileEditor: forwardRef((_props: unknown, _ref: unknown) => <div data-testid="file-editor-stub" />),
}))

vi.mock('./UntitledFileEditor', () => ({
  UntitledFileEditor: () => <div data-testid="untitled-editor-stub" />,
}))

vi.mock('./MobileKeyToolbar', () => ({
  MobileKeyToolbar: () => <div data-testid="mobile-toolbar-stub" />,
}))

let fileQuickOpenCalls: Array<{ open: boolean }> = []
vi.mock('./FileQuickOpen', () => ({
  FileQuickOpen: (props: { open: boolean }) => {
    fileQuickOpenCalls.push(props)
    return null
  },
}))

let contentSearchCalls: Array<{ open: boolean }> = []
vi.mock('./ContentSearchPanel', () => ({
  ContentSearchPanel: (props: { open: boolean }) => {
    contentSearchCalls.push(props)
    return null
  },
}))

vi.mock('./UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}))

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

const project: Project = {
  id: 'p1',
  name: 'devdeck',
  repo: 'org/devdeck',
  path: '/repo',
  expanded: false,
  machineId: 'm1',
  workspaceId: 'ws1',
  worktrees: [],
  issues: [],
  origin: 'hub',
}

vi.mock('@/features/data/queries', () => ({
  useWorkspace: () => ({
    data: { id: 'ws1', name: 'WS', projects: [project], news: [], todos: [], invoices: [], recurringTemplates: [] },
  }),
  useMachines: () => ({ data: [machine] }),
  useUpdateWorktree: () => ({ mutate: vi.fn() }),
  useKillTerminalSession: () => ({ mutate: vi.fn() }),
}))

const worktree: Worktree = {
  id: 'wt-1',
  branch: 'feat/x',
  base: 'main',
  ahead: 0,
  behind: 0,
  model: 'sonnet',
  agent: 'claude',
  state: 'idle',
  task: '',
  tokens: 0,
  elapsed: 0,
  added: 0,
  removed: 0,
  files: 0,
  lines: [],
  pending: null,
}

function resetStore() {
  useDevDeckStore.setState({ worktreeLayouts: {}, shellSidebars: {} })
}

beforeEach(() => {
  resetStore()
  shellSidebarCalls = []
  terminalExplorerCalls = []
  fileQuickOpenCalls = []
  contentSearchCalls = []
})

afterEach(() => {
  cleanup()
  resetStore()
})

describe('ExpandedTerminal - ShellSidebar mount site (spec §2)', () => {
  it('mounts ShellSidebar with the worktree shell key, files target, git target, and content-search shortcut', () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    expect(shellSidebarCalls.length).toBeGreaterThan(0)
    const props = shellSidebarCalls[shellSidebarCalls.length - 1]
    expect(props.shellKey).toBe('wt:wt-1')
    expect(props.target).toEqual({ kind: 'worktree', machine, worktreeId: 'wt-1' })
    expect(props.git).toEqual({ worktreeId: 'wt-1', machine })
    expect(props.contentSearchShortcut).toBe('Ctrl Shift F')
  })

  it('gives ShellSidebar the exact openFile/onFileDeleted callbacks the in-pane explorer tab uses', () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    act(() => {
      fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    })

    expect(terminalExplorerCalls.length).toBeGreaterThan(0)
    const explorerProps = terminalExplorerCalls[terminalExplorerCalls.length - 1]
    const sidebarProps = shellSidebarCalls[shellSidebarCalls.length - 1]
    expect(sidebarProps.onOpenFile).toBe(explorerProps.onOpenFile)
    expect(sidebarProps.onFileDeleted).toBe(explorerProps.onFileDeleted)
  })

  it("routes ShellSidebar's quick-open/content-search requests to the same dialogs the in-pane explorer opens", () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)
    const sidebarProps = shellSidebarCalls[shellSidebarCalls.length - 1]

    act(() => sidebarProps.onRequestQuickOpen())
    expect(fileQuickOpenCalls[fileQuickOpenCalls.length - 1].open).toBe(true)

    act(() => sidebarProps.onRequestContentSearch())
    expect(contentSearchCalls[contentSearchCalls.length - 1].open).toBe(true)
  })
})

describe('ExpandedTerminal - sidebar toggle button (spec §4)', () => {
  it('renders exactly one sidebar toggle on a single-leaf layout', () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)
    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
  })

  it('renders exactly one sidebar toggle, on the first leaf, when the pane is split', () => {
    const base = createDefaultLayout('wt-1')
    const split = splitLeaf(base, base.root.id, 'row', createExplorerContent())
    useDevDeckStore.setState({ worktreeLayouts: { 'wt-1': split } })

    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
  })
})

describe('ExpandedTerminal - Cmd/Ctrl+B (spec §5)', () => {
  it('toggles this shell sidebar when focused and prevents the key reaching xterm', () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)
    expect(useDevDeckStore.getState().shellSidebars['wt:wt-1']?.open ?? true).toBe(true)

    let event!: KeyboardEvent
    act(() => {
      event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(useDevDeckStore.getState().shellSidebars['wt:wt-1']?.open).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(useDevDeckStore.getState().shellSidebars['wt:wt-1']?.open).toBe(true)
  })

  it('leaves the sidebar alone when this tile is not the focused one', () => {
    useDevDeckStore.setState({ shellSidebars: { 'wt:wt-1': { open: true, panel: 'explorer', width: 280 } } })
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused={false} />)

    act(() => {
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    })

    expect(useDevDeckStore.getState().shellSidebars['wt:wt-1']?.open).toBe(true)
  })
})

describe('ExpandedTerminal - regression: in-pane explorer/git tabs', () => {
  it('still opens the explorer and git tabs via Ctrl+E / Ctrl+G', () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    act(() => {
      fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    })
    expect(screen.getAllByTestId('terminal-explorer-stub').length).toBeGreaterThan(0)

    act(() => {
      fireEvent.keyDown(window, { key: 'g', ctrlKey: true })
    })
    expect(screen.getAllByTestId('git-panel-stub').length).toBeGreaterThan(0)
  })
})
