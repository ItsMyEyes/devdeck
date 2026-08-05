import { beforeEach, describe, expect, it } from 'vitest'
import type { ShellSidebarState } from '@/store/useDevDeckStore'
import { shellSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'

// Per-shell sidebar (open/panel/width), keyed by `wt:<worktreeId>` /
// `ssh:<connectionId>` — see docs/superpowers/specs/2026-08-04-sidebar-shell-explorer-design.md §3.

const DEFAULTS = { open: true, panel: 'explorer', width: 280 } as const

beforeEach(() => {
  useDevDeckStore.setState({ shellSidebars: {} })
})

describe('shellSidebars slice', () => {
  it('defaults an unseen key to open explorer at 280px', () => {
    const state = shellSidebarState(useDevDeckStore.getState().shellSidebars, 'wt:never-seen')
    expect(state).toEqual(DEFAULTS)
  })

  it('setShellSidebarWidth clamps below the 200px floor', () => {
    useDevDeckStore.getState().setShellSidebarWidth('wt:a', 10)
    expect(shellSidebarState(useDevDeckStore.getState().shellSidebars, 'wt:a').width).toBe(200)
  })

  it('setShellSidebarWidth clamps above the 560px ceiling', () => {
    useDevDeckStore.getState().setShellSidebarWidth('wt:a', 9999)
    expect(shellSidebarState(useDevDeckStore.getState().shellSidebars, 'wt:a').width).toBe(560)
  })

  it('setShellSidebarWidth passes an in-range value through unchanged', () => {
    useDevDeckStore.getState().setShellSidebarWidth('wt:a', 320)
    expect(shellSidebarState(useDevDeckStore.getState().shellSidebars, 'wt:a').width).toBe(320)
  })

  it('setShellSidebarOpen and setShellSidebarPanel update only the given key', () => {
    useDevDeckStore.getState().setShellSidebarOpen('wt:a', false)
    useDevDeckStore.getState().setShellSidebarPanel('wt:a', 'git')

    const a = shellSidebarState(useDevDeckStore.getState().shellSidebars, 'wt:a')
    expect(a).toEqual({ open: false, panel: 'git', width: 280 })
  })

  it('keeps two shell keys independent', () => {
    useDevDeckStore.getState().setShellSidebarOpen('wt:a', false)
    useDevDeckStore.getState().setShellSidebarPanel('wt:a', 'git')
    useDevDeckStore.getState().setShellSidebarWidth('wt:a', 400)

    useDevDeckStore.getState().setShellSidebarWidth('ssh:b', 250)

    const shellSidebars = useDevDeckStore.getState().shellSidebars
    expect(shellSidebarState(shellSidebars, 'wt:a')).toEqual({ open: false, panel: 'git', width: 400 })
    // 'ssh:b' only had its width touched — open/panel stay at their defaults.
    expect(shellSidebarState(shellSidebars, 'ssh:b')).toEqual({ open: true, panel: 'explorer', width: 250 })
  })

  it('survives the persist partialize round-trip alongside worktreeLayouts', () => {
    useDevDeckStore.getState().setShellSidebarWidth('wt:a', 350)
    useDevDeckStore.getState().setShellSidebarPanel('wt:a', 'git')

    const partialize = useDevDeckStore.persist.getOptions().partialize
    expect(partialize).toBeDefined()
    const persisted = partialize!(useDevDeckStore.getState()) as { shellSidebars?: Record<string, ShellSidebarState> }

    expect(persisted.shellSidebars).toEqual({ 'wt:a': { open: true, panel: 'git', width: 350 } })
  })
})
