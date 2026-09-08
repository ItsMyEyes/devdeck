import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const routerState = vi.hoisted(() => ({ pathname: '/w/ws-1' }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ wsId: 'ws-1' }),
  useNavigate: () => () => undefined,
  useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) =>
    opts?.select ? opts.select({ pathname: routerState.pathname }) : { pathname: routerState.pathname },
}))

const workspace = { id: 'ws-1', name: 'devdeck', projects: [] }

vi.mock('@/features/data/queries', () => ({
  useWorkspace: () => ({ data: workspace, isSuccess: true }),
  useWorkspaces: () => ({ data: [workspace] }),
  useWhoami: () => ({ data: { role: 'hub', lastSyncedAt: '2026-08-29T00:00:00Z' } }),
  useMachines: () => ({ data: [] }),
  useMachineHealth: () => ({ data: undefined }),
  useUpdateProject: () => ({ mutate: () => undefined }),
  useSSHConnections: () => ({ data: [] }),
}))

// Pulls xterm in transitively for one boolean; jsdom has no canvas.
vi.mock('@/features/terminal/ExpandedTerminal', () => ({ useIsDesktop: () => true }))

import { Sidebar } from '@/features/sidebar/Sidebar'
import { createDefaultTileLayout, createSSHShellTab, openTileTab } from '@/features/tabs/tileTree'
import { useDevDeckStore } from '@/store/useDevDeckStore'

describe('Sidebar expanded panel', () => {
  beforeEach(() => {
    routerState.pathname = '/w/ws-1'
    useDevDeckStore.setState({ railExpanded: true })
    useDevDeckStore
      .getState()
      .setWorkspaceTileLayout('ws-1', openTileTab(createDefaultTileLayout(), createSSHShellTab('conn-1')))
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  // The reported bug: the agents list is what `/w/$wsId` renders on the web,
  // but the panel beside it was SSHGroupTree's "GROUPS" header and its
  // "New SSH host" button, left over from a persisted ssh-shell tile.
  it('shows the project tree on the workspace agents route, not the SSH groups', () => {
    render(<Sidebar />)

    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.queryByText('GROUPS')).toBeNull()
    expect(screen.queryByTitle('New SSH host')).toBeNull()
  })

  it('still shows the SSH groups on the SSH route', () => {
    routerState.pathname = '/w/ws-1/ssh'
    render(<Sidebar />)

    expect(screen.getByText('GROUPS')).toBeTruthy()
    expect(screen.queryByText('Projects')).toBeNull()
  })
})
