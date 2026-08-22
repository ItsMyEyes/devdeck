import { forwardRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine, Project, Worktree } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { ExpandedTerminal } from './ExpandedTerminal'
import { createAgentChatPane, createDefaultLayout, createExplorerContent, createTerminalContent, splitLeaf } from './paneTree'
import type { WorktreeLayout } from './paneTree'
import type { ShellSidebarProps } from './ShellSidebar'
import type { TerminalContextSelection } from './Terminal'

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

// T15 (composer-context-attachments, C3): exposes `onSendToChat` (T13's
// real contract) as a per-instance button, keyed by `session` so a test with
// more than one terminal pane open can tell them apart — the fixed selection
// fields (startLine/endLine/text) are this suite's own stand-in for a real
// xterm capture, which `Terminal.test.tsx` already covers on its own.
vi.mock('./Terminal', () => ({
  Terminal: forwardRef(
    (props: { session: string; onSendToChat?: (selection: TerminalContextSelection) => void }, _ref: unknown) => (
      <div data-testid="terminal-stub">
        <button
          type="button"
          onClick={() =>
            props.onSendToChat?.({ text: 'echo hi\necho bye', sessionKey: props.session, startLine: 3, endLine: 5 })
          }
        >
          Send to chat {props.session}
        </button>
      </div>
    ),
  ),
}))

// A fresh worktree now defaults to an agent-chat primary pane (spec decision
// 1), so every test in this file renders one whether it cares or not. Stub
// it the same way Terminal/GitPanel/TerminalExplorer are stubbed below —
// this file is about ExpandedTerminal's own pane/tab wiring, not the chat
// pane's internals (covered by AgentChatPane.test.tsx), and the real
// component would otherwise open a live WebSocket via useAgentChatSocket.
// Renders `threadKey` as text (T15) so a test with more than one chat pane
// open can tell them apart.
vi.mock('@/features/agent-chat/AgentChatPane', () => ({
  AgentChatPane: (props: { threadKey: string }) => <div data-testid="agent-chat-stub">{props.threadKey}</div>,
}))

// T15's C3 bridge — `ExpandedTerminal` calls this directly (a module-level
// registry, not a ref prop; see `ChatComposer.tsx`'s own doc comment on why)
// rather than through `AgentChatPane`, which this suite stubs out above.
const insertTerminalContextMock = vi.fn()
vi.mock('@/features/agent-chat/ChatComposer', () => ({
  insertTerminalContext: (...args: unknown[]) => insertTerminalContextMock(...args),
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
  // Backs the "+" menu's "New Chat" action (nextFreeThreadKey's `taken` list) —
  // no session anywhere in this file's suite, so an empty list every time.
  useAgentThreads: () => ({ data: [] }),
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
  insertTerminalContextMock.mockReset()
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

describe('ExpandedTerminal - "+" menu: New Chat', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('opens a fresh chat thread as its own tab, and a second click opens a second one', async () => {
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    // A fresh worktree already defaults to a chat pane (spec decision 1) —
    // this test is about the "+" menu minting an ADDITIONAL thread, not the
    // pane that exists from the start.
    expect(screen.getAllByTestId('agent-chat-stub')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New Chat' }))
    expect(screen.getAllByTestId('agent-chat-stub')).toHaveLength(2)
    expect(screen.getByText('Chat 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New Chat' }))
    expect(screen.getAllByTestId('agent-chat-stub')).toHaveLength(3)
    expect(screen.getByText('Chat 3')).toBeInTheDocument()
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

// Composer-context-attachments plan, T15 (C3): the bridge from a terminal's
// "Send to chat" affordance (T13) to the composer's `terminalContext` chip
// (T14), via `ChatComposer.tsx`'s own module-level registry.
describe('ExpandedTerminal - terminal-context capture bridge (C3)', () => {
  /** Primary chat pane (`wt-1`) split beside a spawned terminal
   *  (`wt-1::term-1`, label "Terminal 2") — the chat pane starts focused so
   *  `layout.focusedPaneId` never has to collide with the terminal's own id
   *  (both a terminal's and a chat's *primary* pane use the bare worktree
   *  id — see `paneTree.ts`'s id-uniqueness rules). */
  function chatAndTerminalLayout(focusedPaneId: 'pane-chat' | 'pane-term'): WorktreeLayout {
    const chat = createAgentChatPane('wt-1')
    const term = createTerminalContent('wt-1', 1)
    return {
      version: 1,
      nextTerminalSeq: 2,
      focusedPaneId,
      root: {
        type: 'split',
        id: 'root',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', id: 'pane-chat', tabs: [chat], activeTabId: chat.id },
          { type: 'leaf', id: 'pane-term', tabs: [term], activeTabId: term.id },
        ],
      },
    }
  }

  /** Two chat panes (primary `wt-1` and extra `wt-1::chat-2`) plus a
   *  terminal — lets a test prove "the last-focused chat tab" against the
   *  DEFAULT fallback (the primary), not just against "no chat exists". */
  function twoChatsAndTerminalLayout(focusedPaneId: string): WorktreeLayout {
    const chatA = createAgentChatPane('wt-1')
    const chatB = createAgentChatPane('wt-1', 2)
    const term = createTerminalContent('wt-1', 1)
    return {
      version: 1,
      nextTerminalSeq: 2,
      focusedPaneId,
      root: {
        type: 'split',
        id: 'root',
        direction: 'row',
        sizes: [1 / 3, 1 / 3, 1 / 3],
        children: [
          { type: 'leaf', id: 'pane-a', tabs: [chatA], activeTabId: chatA.id },
          { type: 'leaf', id: 'pane-b', tabs: [chatB], activeTabId: chatB.id },
          { type: 'leaf', id: 'pane-c', tabs: [term], activeTabId: term.id },
        ],
      },
    }
  }

  it('routes a capture to the only open chat pane and refocuses it, when no chat has ever been explicitly focused', () => {
    useDevDeckStore.setState({ worktreeLayouts: { 'wt-1': chatAndTerminalLayout('pane-term') } })
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    fireEvent.click(screen.getByRole('button', { name: 'Send to chat wt-1::term-1' }))

    expect(insertTerminalContextMock).toHaveBeenCalledWith(
      'wt-1',
      'wt-1::term-1/L3-L5',
      'Terminal 2 lines 3-5',
      'echo hi\necho bye',
    )
    expect(useDevDeckStore.getState().worktreeLayouts['wt-1']?.focusedPaneId).toBe('pane-chat')
  })

  it('opens the primary chat pane when capturing from a worktree with no chat pane open at all', () => {
    // A spawned terminal only (`wt-1::term-1`), deliberately not
    // `createDefaultLayout`'s bare-id primary — a terminal's primary pane
    // and a chat's primary pane share the SAME id scheme (the bare worktree
    // id, `paneTree.ts`'s "one instance per target" rule), so a layout with
    // both at once is not a real reachable state and isn't what this test is
    // about; the only fact this test needs is "no agent-chat tab exists yet".
    const term = createTerminalContent('wt-1', 1)
    const layout: WorktreeLayout = {
      version: 1,
      nextTerminalSeq: 2,
      focusedPaneId: 'pane-term',
      root: { type: 'leaf', id: 'pane-term', tabs: [term], activeTabId: term.id },
    }
    useDevDeckStore.setState({ worktreeLayouts: { 'wt-1': layout } })
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    expect(screen.queryByTestId('agent-chat-stub')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send to chat wt-1::term-1' }))

    expect(insertTerminalContextMock).toHaveBeenCalledWith(
      'wt-1',
      'wt-1::term-1/L3-L5',
      'Terminal 2 lines 3-5',
      'echo hi\necho bye',
    )
    expect(screen.getByTestId('agent-chat-stub')).toBeInTheDocument()
  })

  it('routes a capture to the last-focused chat tab, not whichever pane is focused at capture time', () => {
    // Chat B (`wt-1::chat-2`) starts focused — tracked as "last focused
    // chat" the moment this mounts. Then focus moves to the terminal pane
    // WITHOUT any chat pane being refocused in between: `layout.focusedPaneId`
    // is the terminal at the moment of capture below, but B is still what was
    // last focused, and the DEFAULT fallback (the primary, `wt-1`) would give
    // the wrong answer if this test passed only by accident of that default.
    const layout = twoChatsAndTerminalLayout('pane-b')
    useDevDeckStore.setState({ worktreeLayouts: { 'wt-1': layout } })
    render(<ExpandedTerminal worktree={worktree} wsId="ws1" projectId="p1" isFocused />)

    act(() => {
      useDevDeckStore.getState().setWorktreeLayout('wt-1', { ...layout, focusedPaneId: 'pane-c' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send to chat wt-1::term-1' }))

    expect(insertTerminalContextMock).toHaveBeenCalledWith(
      'wt-1::chat-2',
      'wt-1::term-1/L3-L5',
      'Terminal 2 lines 3-5',
      'echo hi\necho bye',
    )
  })
})
