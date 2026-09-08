import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const routerState = vi.hoisted(() => ({ pathname: '/w/ws-1', navigations: [] as unknown[] }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ wsId: 'ws-1' }),
  useNavigate: () => (opts: unknown) => routerState.navigations.push(opts),
  useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) =>
    opts?.select ? opts.select({ pathname: routerState.pathname }) : { pathname: routerState.pathname },
}))

vi.mock('@/features/data/queries', () => ({
  useWorkspace: () => ({ data: undefined, isSuccess: false }),
}))

import { SidebarNav } from '@/features/sidebar/SidebarNav'
import { createDefaultTileLayout, createSSHShellTab, findTileLeaf, openTileTab } from '@/features/tabs/tileTree'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function focusedTabId() {
  const layout = useDevDeckStore.getState().workspaceTileLayouts['ws-1']
  const leaf = layout && findTileLeaf(layout.root, layout.focusedLeafId)
  return leaf?.type === 'leaf' ? leaf.activeTabId : undefined
}

describe('SidebarNav Agents rail entry', () => {
  beforeEach(() => {
    routerState.pathname = '/w/ws-1'
    routerState.navigations = []
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    useDevDeckStore
      .getState()
      .setWorkspaceTileLayout('ws-1', openTileTab(createDefaultTileLayout(), createSSHShellTab('conn-1')))
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  // An ssh-shell tile routes to the bare `/w/$wsId` too (WorkspaceTileArea's
  // `navigateToTab`), so navigating alone is a no-op from one: same URL, same
  // focused tab, same SSH sidebar. The Agents entry has to select the pinned
  // Agents tab as well — exactly what ProjectTree's "All agents" row and the
  // palette's `openProject` already do.
  it('selects the pinned Agents tab, not just the route', async () => {
    render(<SidebarNav />)
    expect(focusedTabId()).toBe('ssh-conn-1')

    await userEvent.click(screen.getByLabelText('Agents'))

    expect(focusedTabId()).toBe('agents')
    expect(routerState.navigations).toEqual([{ to: '/w/$wsId', params: { wsId: 'ws-1' } }])
  })

  it('leaves the tile focus alone for the other rail entries', async () => {
    render(<SidebarNav />)

    await userEvent.click(screen.getByLabelText('Runtimes'))

    expect(focusedTabId()).toBe('ssh-conn-1')
    expect(routerState.navigations).toEqual([{ to: '/w/$wsId/machines', params: { wsId: 'ws-1' } }])
  })
})
