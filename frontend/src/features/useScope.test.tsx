import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const routerState = vi.hoisted(() => ({ pathname: '/w/ws-1' }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ wsId: 'ws-1' }),
  useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) =>
    opts?.select ? opts.select({ pathname: routerState.pathname }) : { pathname: routerState.pathname },
}))

import { useScope } from '@/features/useScope'
import { createDefaultTileLayout, createSSHShellTab, openTileTab } from '@/features/tabs/tileTree'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function ViewProbe() {
  return <span data-testid="view">{useScope().view}</span>
}

function view() {
  return screen.getByTestId('view').textContent
}

describe('useScope view derivation', () => {
  beforeEach(() => {
    routerState.pathname = '/w/ws-1'
    // The state the SSH command-palette entry leaves behind: an ssh-shell tab
    // opened into the focused leaf, persisted in `devdeck-ui-v2`.
    useDevDeckStore
      .getState()
      .setWorkspaceTileLayout('ws-1', openTileTab(createDefaultTileLayout(), createSSHShellTab('conn-1')))
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  // The tile tree only drives the UI inside Tauri (`w.$wsId.tsx` mounts
  // WorkspaceTileArea on `isTauri` alone). On the web `/w/$wsId` always
  // renders WorkspaceHostsView through `<Outlet/>`, so letting a persisted
  // ssh-shell tab win the tie-break pins the sidebar to SSHGroupTree while
  // the agents list is on screen — with no way back, since the only control
  // that re-selects the Agents tab lives inside the hidden panel.
  it('ignores the persisted tile focus on the web build', () => {
    render(<ViewProbe />)
    expect(view()).toBe('agents')
  })

  it('still lets a focused ssh-shell tile win the tie-break inside Tauri', () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    render(<ViewProbe />)
    expect(view()).toBe('ssh')
  })

  it('keeps deriving the view from the path when one is explicit', () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    routerState.pathname = '/w/ws-1/machines'
    render(<ViewProbe />)
    expect(view()).toBe('machines')
  })
})
