import { describe, expect, it } from 'vitest'
import { assemblePaletteItems } from '@/features/palette/useCommandPalette'
import { rankPaletteItems } from '@/features/palette/paletteRank'
import type { PaletteItem } from '@/features/palette/paletteTypes'

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'id' | 'title' | 'group'>): PaletteItem {
  return { kind: 'worktree', ...partial }
}

describe('assemblePaletteItems', () => {
  it('shows only open tabs, recent and create for an empty query', () => {
    const items = assemblePaletteItems({
      query: '',
      openTabs: [item({ id: 'open:leaf-a:agents', title: 'agents', group: 'open', kind: 'open-tab' })],
      entities: [item({ id: 'worktree:wt1', title: 'feat/palette', group: 'results' })],
      bookmarks: [item({ id: 'bookmark:b1', title: 'API repo', group: 'results', kind: 'bookmark' })],
      verbHints: [item({ id: 'verb:ssh', title: 'ssh <host>', group: 'results', kind: 'command' })],
      createActions: [item({ id: 'create:ssh', title: 'New SSH…', group: 'create', kind: 'create' })],
      recent: [item({ id: 'worktree:wt2', title: 'main', group: 'recent' })],
    })
    const groups = rankPaletteItems(items, '', () => 0).map((g) => g.group)
    expect(groups).toEqual(['open', 'recent', 'create'])
  })

  it('includes entities, bookmarks and verb hints once the query is non-empty', () => {
    const items = assemblePaletteItems({
      query: 'feat',
      openTabs: [],
      entities: [item({ id: 'worktree:wt1', title: 'feat/palette', group: 'results' })],
      bookmarks: [],
      verbHints: [],
      createActions: [item({ id: 'create:ssh', title: 'New SSH…', group: 'create', kind: 'create' })],
      recent: [],
    })
    const groups = rankPaletteItems(items, 'feat', () => 0).map((g) => g.group)
    expect(groups).toEqual(['results', 'create'])
  })
})
