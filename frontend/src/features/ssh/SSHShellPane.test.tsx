import { forwardRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSHConnection } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { createDefaultLayout, createExplorerContent, splitLeaf } from '@/features/terminal/paneTree'
import type { ShellSidebarProps } from '@/features/terminal/ShellSidebar'
import { SSHShellPane } from './SSHShellPane'

/**
 * Covers spec §2 (ShellSidebar mount site), §4 (the sidebar toggle button,
 * rendered only on the first leaf), and §5 (Cmd/Ctrl+B) for the SSH pane —
 * see docs/superpowers/specs/2026-08-04-sidebar-shell-explorer-design.md.
 * Mirrors ExpandedTerminal.test.tsx; `ShellSidebarToggle`/`OverflowItem`/
 * `useIsDesktop` are shared with ExpandedTerminal.tsx and used for real here
 * (not mocked) — everything else heavy is stubbed.
 */

// jsdom implements no layout at all, so `offsetParent` is always `null` —
// the keydown handler's "is this tab actually the one on screen" guard
// would bail unconditionally without this, regardless of `isFocused`.
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
vi.mock('@/features/terminal/ShellSidebar', () => ({
  ShellSidebar: (props: ShellSidebarProps) => {
    shellSidebarCalls.push(props)
    return <div data-testid="shell-sidebar-stub">{props.shellKey}</div>
  },
}))

vi.mock('./SSHTerminal', () => ({
  SSHTerminal: () => <div data-testid="ssh-terminal-stub" />,
}))

let terminalExplorerCalls: Array<Record<string, unknown>> = []
vi.mock('@/features/terminal/TerminalExplorer', () => ({
  TerminalExplorer: (props: Record<string, unknown>) => {
    terminalExplorerCalls.push(props)
    return <div data-testid="terminal-explorer-stub" />
  },
}))

vi.mock('@/features/terminal/SSHFileEditor', () => ({
  SSHFileEditor: forwardRef((_props: unknown, _ref: unknown) => <div data-testid="ssh-file-editor-stub" />),
}))

let fileQuickOpenCalls: Array<{ open: boolean }> = []
vi.mock('@/features/terminal/FileQuickOpen', () => ({
  FileQuickOpen: (props: { open: boolean }) => {
    fileQuickOpenCalls.push(props)
    return null
  },
}))

let contentSearchCalls: Array<{ open: boolean }> = []
vi.mock('@/features/terminal/ContentSearchPanel', () => ({
  ContentSearchPanel: (props: { open: boolean }) => {
    contentSearchCalls.push(props)
    return null
  },
}))

vi.mock('@/features/terminal/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}))

const connection: SSHConnection = {
  id: 'conn-1',
  name: 'staging box',
  group: '',
  host: 'staging.example.com',
  port: 22,
  username: 'ops',
  authType: 'password',
  jumpConnectionId: null,
  executorMachineId: null,
  hostKeyFingerprint: null,
}

vi.mock('@/features/data/queries', () => ({
  useSSHConnections: () => ({ data: [connection] }),
}))

function resetStore() {
  useDevDeckStore.setState({ sshTileLayouts: {}, shellSidebars: {} })
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

describe('SSHShellPane — ShellSidebar mount site (spec §2)', () => {
  it('mounts ShellSidebar with the ssh shell key and files target, and no git target or content-search shortcut', () => {
    render(<SSHShellPane connectionId="conn-1" isFocused />)

    expect(shellSidebarCalls.length).toBeGreaterThan(0)
    const props = shellSidebarCalls[shellSidebarCalls.length - 1]
    expect(props.shellKey).toBe('ssh:conn-1')
    expect(props.target).toEqual({ kind: 'ssh', connectionId: 'conn-1' })
    expect(props.git).toBeUndefined()
    expect(props.contentSearchShortcut).toBeUndefined()
  })

  it('gives ShellSidebar the exact openFile/onFileDeleted callbacks the in-pane explorer tab uses', () => {
    render(<SSHShellPane connectionId="conn-1" isFocused />)

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
    render(<SSHShellPane connectionId="conn-1" isFocused />)
    const sidebarProps = shellSidebarCalls[shellSidebarCalls.length - 1]

    act(() => sidebarProps.onRequestQuickOpen())
    expect(fileQuickOpenCalls[fileQuickOpenCalls.length - 1].open).toBe(true)

    act(() => sidebarProps.onRequestContentSearch())
    expect(contentSearchCalls[contentSearchCalls.length - 1].open).toBe(true)
  })
})

describe('SSHShellPane — sidebar toggle button (spec §4)', () => {
  it('renders exactly one sidebar toggle on a single-leaf layout', () => {
    render(<SSHShellPane connectionId="conn-1" isFocused />)
    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
  })

  it('renders exactly one sidebar toggle, on the first leaf, when the pane is split', () => {
    const base = createDefaultLayout('conn-1')
    const split = splitLeaf(base, base.root.id, 'row', createExplorerContent())
    useDevDeckStore.setState({ sshTileLayouts: { 'conn-1': split } })

    render(<SSHShellPane connectionId="conn-1" isFocused />)

    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
  })
})

describe('SSHShellPane — Cmd/Ctrl+B (spec §5)', () => {
  it('toggles this shell sidebar when focused and prevents the key reaching xterm', () => {
    render(<SSHShellPane connectionId="conn-1" isFocused />)
    expect(useDevDeckStore.getState().shellSidebars['ssh:conn-1']?.open ?? true).toBe(true)

    let event!: KeyboardEvent
    act(() => {
      event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(useDevDeckStore.getState().shellSidebars['ssh:conn-1']?.open).toBe(false)
  })

  it('leaves the sidebar alone when this tile is not the focused one', () => {
    useDevDeckStore.setState({ shellSidebars: { 'ssh:conn-1': { open: true, panel: 'explorer', width: 280 } } })
    render(<SSHShellPane connectionId="conn-1" isFocused={false} />)

    act(() => {
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    })

    expect(useDevDeckStore.getState().shellSidebars['ssh:conn-1']?.open).toBe(true)
  })
})

describe('SSHShellPane — regression: in-pane explorer tab', () => {
  it('still opens the explorer tab via Ctrl+E', () => {
    render(<SSHShellPane connectionId="conn-1" isFocused />)

    act(() => {
      fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    })
    expect(screen.getAllByTestId('terminal-explorer-stub').length).toBeGreaterThan(0)
  })
})
