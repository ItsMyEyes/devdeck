// The workspace-switch stall, pinned as a test.
//
// A workspace's tile strip can hold many tabs, and each one's body is
// expensive: an agent chat mounts ~80 Streamdown entries (~9,000 DOM nodes),
// a worktree tab mounts an xterm plus its own WebGL context. Switching
// workspace replaces the whole layout, so if every tab's body is mounted
// eagerly, one click rebuilds all of them inside a single synchronous commit
// — measured at ~490ms of blocked main thread for four open agent tabs, and
// growing with every extra project left open.
//
// These tests state the rule that removes that cost: a tab's body exists once
// it has been opened, and not before.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import type { WorkspaceTileCanvasProps } from './WorkspaceTileCanvas'
import type { TileLeaf, TileTab } from './tileTree'

afterEach(() => {
  cleanup()
})

const AGENTS: TileTab = { kind: 'agents', id: 'agents' }
const worktreeTab = (id: string): TileTab => ({ kind: 'worktree', id, projectId: 'p1', wtId: id })

function leaf(id: string, tabs: TileTab[], activeTabId: string): TileLeaf {
  return { type: 'leaf', id, tabs, activeTabId }
}

/** A body per tab kind, tagged so "mounted" is measured the way the browser
 *  pays for it — a rendered subtree — rather than by a CSS class. */
const renderers: WorkspaceTileCanvasProps['renderers'] = {
  agents: () => <div data-testid="body-agents" />,
  worktree: ({ tab }) => <div data-testid={`body-${tab.wtId}`} />,
  browser: () => <div data-testid="body-browser" />,
  sshShell: () => <div data-testid="body-ssh" />,
}

function canvas(root: TileLeaf) {
  return (
    <WorkspaceTileCanvas
      root={root}
      focusedLeafId={root.id}
      renderers={renderers}
      onTreeChange={() => {}}
      onFocusLeaf={() => {}}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onNewTab={() => {}}
      resolveWorktreeTab={(tab) => ({ title: tab.wtId, prefix: 'proj/local', name: tab.wtId })}
      resolveBrowserTab={() => ({ label: 'Web' })}
      resolveSSHShellTab={() => ({ label: 'SSH' })}
    />
  )
}

describe('tile tab bodies', () => {
  it('builds only the active tab, not every open tab', () => {
    render(canvas(leaf('leaf-1', [AGENTS, worktreeTab('wt-a'), worktreeTab('wt-b')], 'agents')))

    // All three tabs are in the strip...
    expect(screen.getByTitle(/wt-a/)).toBeInTheDocument()
    expect(screen.getByTitle(/wt-b/)).toBeInTheDocument()
    // ...and only the open one has a body.
    expect(screen.getByTestId('body-agents')).toBeInTheDocument()
    expect(screen.queryByTestId('body-wt-a')).toBeNull()
    expect(screen.queryByTestId('body-wt-b')).toBeNull()
  })

  it('keeps a tab mounted after it goes background, so switching back is free', () => {
    const tabs = [AGENTS, worktreeTab('wt-a'), worktreeTab('wt-b')]
    const { rerender } = render(canvas(leaf('leaf-1', tabs, 'agents')))

    rerender(canvas(leaf('leaf-1', tabs, 'wt-a')))
    // The newly-opened tab is built, and the one we came from is NOT thrown
    // away — a live terminal or agent socket in a backgrounded tab keeps
    // running, and coming back to it must stay a `display` toggle.
    expect(screen.getByTestId('body-wt-a')).toBeInTheDocument()
    expect(screen.getByTestId('body-agents')).toBeInTheDocument()
    // Still untouched: never opened, never built.
    expect(screen.queryByTestId('body-wt-b')).toBeNull()

    rerender(canvas(leaf('leaf-1', tabs, 'agents')))
    expect(screen.getByTestId('body-wt-a')).toBeInTheDocument()
    expect(screen.getByTestId('body-agents')).toBeInTheDocument()
  })

  it('re-anchors on a workspace switch instead of inheriting the last workspace', () => {
    // React reuses one `TileLeafView` instance across this change: same
    // component, same position in the tree, only the leaf underneath it
    // differs. Without re-anchoring on the leaf id, the "already opened" tab
    // ids of the workspace being left would leak into the one being entered.
    const { rerender } = render(canvas(leaf('ws1-leaf', [AGENTS, worktreeTab('wt-a')], 'wt-a')))
    expect(screen.getByTestId('body-wt-a')).toBeInTheDocument()

    rerender(canvas(leaf('ws2-leaf', [AGENTS, worktreeTab('wt-x'), worktreeTab('wt-y')], 'wt-x')))

    // The destination workspace pays for exactly one body, not for every tab
    // it has open — this is the switch that used to stall.
    expect(screen.getByTestId('body-wt-x')).toBeInTheDocument()
    expect(screen.queryByTestId('body-wt-y')).toBeNull()
    expect(screen.queryByTestId('body-agents')).toBeNull()
  })
})
