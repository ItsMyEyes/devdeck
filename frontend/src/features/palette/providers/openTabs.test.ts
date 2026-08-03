import { describe, expect, it, vi } from 'vitest'
import { openTabItems } from '@/features/palette/providers/openTabs'
import { TAB_KIND_ICON } from '@/features/tabs/tabIcons'
import type { TileTab, WorkspaceTileLayout } from '@/features/tabs/tileTree'

const resolve = (tab: TileTab) => ({ title: tab.id, subtitle: tab.kind })

function layout(): WorkspaceTileLayout {
  return {
    version: 1,
    focusedLeafId: 'leaf-a',
    root: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        {
          type: 'leaf',
          id: 'leaf-a',
          activeTabId: 'agents',
          tabs: [
            { kind: 'agents', id: 'agents' },
            { kind: 'browser', id: 'br-1' },
          ],
        },
        {
          type: 'leaf',
          id: 'leaf-b',
          activeTabId: 'ssh-c1',
          tabs: [{ kind: 'ssh-shell', id: 'ssh-c1', connectionId: 'c1' }],
        },
      ],
    },
  }
}

describe('openTabItems', () => {
  it('walks every leaf in the tree', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.map((i) => i.title)).toEqual(['agents', 'br-1', 'ssh-c1'])
  })

  it('puts every item in the open group with kind open-tab', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.every((i) => i.group === 'open' && i.kind === 'open-tab')).toBe(true)
  })

  it('gives every row the icon of the menu its tab belongs to', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.map((i) => i.icon)).toEqual([
      TAB_KIND_ICON.agents,
      TAB_KIND_ICON.browser,
      TAB_KIND_ICON['ssh-shell'],
    ])
    expect(items.every((i) => i.icon !== undefined)).toBe(true)
  })

  it('marks the active tab of each leaf', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.find((i) => i.title === 'agents')?.subtitle).toContain('active')
    expect(items.find((i) => i.title === 'br-1')?.subtitle).not.toContain('active')
  })

  it('gives each item an id namespaced by leaf so the same tab in two leaves is distinct', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.map((i) => i.id)).toEqual(['open:leaf-a:agents', 'open:leaf-a:br-1', 'open:leaf-b:ssh-c1'])
  })

  it('focuses the owning leaf and tab when run', () => {
    const focus = vi.fn()
    const items = openTabItems(layout(), resolve, focus)
    items[2].run?.({ wsId: 'ws1', leafId: 'leaf-a', showToast: () => {}, close: () => {} })
    expect(focus).toHaveBeenCalledWith('leaf-b', 'ssh-c1')
  })

  it('returns an empty list for a layout with no tabs', () => {
    const empty: WorkspaceTileLayout = {
      version: 1,
      focusedLeafId: 'l',
      root: { type: 'leaf', id: 'l', tabs: [], activeTabId: '' },
    }
    expect(openTabItems(empty, resolve, () => {})).toEqual([])
  })
})
