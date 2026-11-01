import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommandPalette } from '@/features/palette/useCommandPalette'

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn(), openLocalTerminalTab: vi.fn(), closePalette: vi.fn(), navigate: vi.fn(),
  noop: vi.fn(), machines: [{ id: 'm-remote', name: 'remote' }, { id: 'm-local', name: 'local' }],
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@/features/tabs/useIsTauri', () => ({ useIsTauri: () => true }))
vi.mock('@/features/ssh/useOpenSSHShell', () => ({ useOpenSSHShell: () => mocks.noop }))
vi.mock('@/features/theme/useTheme', () => ({ useThemePreference: () => ['system', mocks.noop] }))
vi.mock('@/features/data/queries', () => ({
  useWorkspace: () => ({ data: { projects: [] }, isSuccess: true }),
  useMachines: () => ({ data: mocks.machines, isSuccess: true }),
  useSSHConnections: () => ({ data: [], isSuccess: true }),
  useBookmarks: () => ({ data: [], isSuccess: true }),
  useMachinesHealth: () => new Map(),
  useCreateSSHConnection: () => ({ mutateAsync: mocks.noop }),
}))
vi.mock('@/store/useDevDeckStore', () => {
  const state = {
    showToast: mocks.noop, closePalette: mocks.closePalette, openSSHQuickAdd: mocks.noop,
    openWorktreeTab: mocks.noop, openBrowserTab: mocks.openBrowserTab,
    openLocalTerminalTab: mocks.openLocalTerminalTab, openSpawn: mocks.noop,
    selectAgentsTab: mocks.noop, setWorkspaceTileLayout: mocks.noop,
    setSSHTileLayout: mocks.noop, workspaceTileLayouts: {}, browserTiles: {}, sshTileLayouts: {},
  }
  return { useDevDeckStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }
})

describe('new tab search flow', () => {
  beforeEach(() => vi.clearAllMocks())
  it('opens the local terminal when Enter is pressed on terminal', () => {
    const { result } = renderHook(() => useCommandPalette({ wsId: 'ws1', leafId: 'leaf', open: true, mode: 'new-tab' }))
    act(() => result.current.setQuery('terminal'))
    act(() => result.current.run())
    expect(mocks.openLocalTerminalTab).toHaveBeenCalledWith('ws1')
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
    expect(mocks.closePalette).toHaveBeenCalled()
  })
  it('searches Google with the actual typed text', () => {
    const { result } = renderHook(() => useCommandPalette({ wsId: 'ws1', leafId: 'leaf', open: true, mode: 'new-tab' }))
    act(() => result.current.setQuery('zsh aliases'))
    act(() => result.current.run())
    expect(mocks.openBrowserTab).toHaveBeenCalledWith('ws1', undefined, 'https://www.google.com/search?q=zsh+aliases')
    expect(mocks.closePalette).toHaveBeenCalled()
  })
  it('opens typed URLs on the local browser', () => {
    const { result } = renderHook(() => useCommandPalette({ wsId: 'ws1', leafId: 'leaf', open: true, mode: 'new-tab' }))
    act(() => result.current.setQuery('example.com'))
    act(() => result.current.run())
    expect(mocks.openBrowserTab).toHaveBeenCalledWith('ws1', undefined, 'https://example.com')
  })

})
