import { describe, expect, it } from 'vitest'
import { flattenRanked, rankPaletteItems } from '@/features/palette/paletteRank'
import type { PaletteItem } from '@/features/palette/paletteTypes'

const noFrecency = () => 0

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'id' | 'title' | 'group'>): PaletteItem {
  return { kind: 'worktree', ...partial }
}

describe('rankPaletteItems', () => {
  it('always renders groups in the fixed order', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'c', title: 'New Browser tab', group: 'create', kind: 'create' }),
        item({ id: 'r', title: 'alpha', group: 'results' }),
        item({ id: 'o', title: 'alpha', group: 'open' }),
        item({ id: 'm', title: 'alpha', group: 'recent' }),
      ],
      '',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['open', 'recent', 'results', 'create'])
  })

  it('keeps the create group even when the query matches nothing else', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'r', title: 'alpha', group: 'results' }),
        item({ id: 'c', title: 'New SSH', group: 'create', kind: 'create' }),
      ],
      'zzzz',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['create'])
    expect(flattenRanked(groups)[0].id).toBe('c')
  })

  it('never filters the create group by the query', () => {
    const groups = rankPaletteItems(
      [item({ id: 'c', title: 'New SSH host', group: 'create', kind: 'create' })],
      'totally unrelated',
      noFrecency,
    )
    expect(flattenRanked(groups)).toHaveLength(1)
  })

  it('ranks an exact prefix above a mere subsequence', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'sub', title: 'peer-review-order-daemon', group: 'results' }),
        item({ id: 'pre', title: 'prod-db', group: 'results' }),
      ],
      'prod',
      noFrecency,
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['pre', 'sub'])
  })

  it('breaks ties by frecency', () => {
    const groups = rankPaletteItems(
      [item({ id: 'cold', title: 'alpha', group: 'results' }), item({ id: 'hot', title: 'alpha', group: 'results' })],
      'alpha',
      (id) => (id === 'hot' ? 100 : 0),
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['hot', 'cold'])
  })

  it('ranks an open-but-cold entity above a closed-but-hot one', () => {
    const groups = rankPaletteItems(
      [item({ id: 'open-cold', title: 'alpha', group: 'results' }), item({ id: 'closed-hot', title: 'alpha', group: 'results' })],
      'alpha',
      (id) => (id === 'closed-hot' ? 100 : 0),
      (id) => id === 'open-cold',
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['open-cold', 'closed-hot'])
  })

  it('matches against keywords as well as the title', () => {
    const groups = rankPaletteItems(
      [item({ id: 'k', title: 'prod-db', group: 'results', keywords: ['10.1.1.4'] })],
      '10.1.1',
      noFrecency,
    )
    expect(flattenRanked(groups)).toHaveLength(1)
  })

  it('caps a group at 8 rows and reports the remainder', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `w${i}`, title: `alpha-${i}`, group: 'results' }))
    const groups = rankPaletteItems(many, 'alpha', noFrecency)
    expect(groups[0].items).toHaveLength(8)
    expect(groups[0].truncated).toBe(4)
  })

  it('attaches highlight ranges to matched items', () => {
    const groups = rankPaletteItems([item({ id: 'p', title: 'prod-db', group: 'results' })], 'prod', noFrecency)
    expect(flattenRanked(groups)[0].ranges).toEqual([[0, 4]])
  })

  it('drops empty non-create groups entirely', () => {
    const groups = rankPaletteItems(
      [item({ id: 'o', title: 'alpha', group: 'open' }), item({ id: 'c', title: 'New SSH', group: 'create', kind: 'create' })],
      'zzz',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['create'])
  })
})
