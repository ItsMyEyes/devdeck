import type { TileNode, TileTab, WorkspaceTileLayout } from '@/features/tabs/tileTree'
import type { PaletteItem } from '@/features/palette/paletteTypes'

export interface TabLabel {
  title: string
  subtitle?: string
}

export type ResolveTabLabel = (tab: TileTab) => TabLabel

/**
 * Every tab currently open anywhere in the layout, in tree order.
 *
 * Ids are namespaced by leaf (`open:<leafId>:<tabId>`) because the same
 * worktree can legitimately be open in two leaves at once, and the palette's
 * selection model requires unique ids.
 *
 * Running an item focuses the leaf that owns it rather than opening anything
 * — that is the "window switcher" half of the palette.
 */
export function openTabItems(
  layout: WorkspaceTileLayout,
  resolve: ResolveTabLabel,
  focus: (leafId: string, tabId: string) => void,
): PaletteItem[] {
  const items: PaletteItem[] = []

  function walk(node: TileNode) {
    if (node.type === 'leaf') {
      for (const tab of node.tabs) {
        const label = resolve(tab)
        const isActive = tab.id === node.activeTabId
        const parts = [label.subtitle, isActive ? 'active' : undefined].filter(Boolean)
        items.push({
          id: `open:${node.id}:${tab.id}`,
          kind: 'open-tab',
          group: 'open',
          title: label.title,
          subtitle: parts.length > 0 ? parts.join(' · ') : undefined,
          keywords: [tab.kind],
          run: () => focus(node.id, tab.id),
        })
      }
      return
    }
    node.children.forEach(walk)
  }

  walk(layout.root)
  return items
}
