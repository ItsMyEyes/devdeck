import { describe, expect, it, vi } from 'vitest'
import { assemblePaletteItems, paletteRankQuery } from '@/features/palette/useCommandPalette'
import { rankPaletteItems } from '@/features/palette/paletteRank'
import { agentProjectRows } from '@/features/palette/providers/createActions'
import type { CreateActionDeps } from '@/features/palette/providers/createActions'
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
      appearance: [item({ id: 'appearance:light', title: 'Appearance: Light', group: 'create', kind: 'command' })],
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
      appearance: [],
      recent: [],
    })
    const groups = rankPaletteItems(items, 'feat', () => 0).map((g) => g.group)
    expect(groups).toEqual(['results', 'create'])
  })

  // Three rows that never change would sit in Create on every open; they are
  // only worth showing once the user is actually looking for them.
  it('keeps the appearance rows out of the empty-query view and in once searched', () => {
    const appearance = [
      item({ id: 'appearance:light', title: 'Appearance: Light', group: 'create', kind: 'command' }),
    ]
    const sources = {
      openTabs: [],
      entities: [],
      bookmarks: [],
      verbHints: [],
      createActions: [],
      appearance,
      recent: [],
    }
    expect(assemblePaletteItems({ ...sources, query: '' })).toEqual([])
    expect(assemblePaletteItems({ ...sources, query: 'appearance' })).toEqual(appearance)
  })
})

describe('paletteRankQuery', () => {
  it('returns the verb arg when a verb is active and no page is open', () => {
    expect(paletteRankQuery('agent-new mabes', 'mabes', false)).toBe('mabes')
  })

  it('returns the raw query when a drill-down page is active, even if a verb also parses', () => {
    expect(paletteRankQuery('agent-new mabes', 'mabes', true)).toBe('agent-new mabes')
  })

  it('returns the raw query when there is no verb', () => {
    expect(paletteRankQuery('feat/palette', null, false)).toBe('feat/palette')
  })
})

// Regression: rankPaletteItems used to be called with the *full* query
// ("agent-new mabes"), but verb rows are titled with the entity name
// ("superapps_mabes") — nothing matched, and all three verbs rendered zero
// rows. paletteRankQuery fixes this by scoring against the verb's argument
// alone; these tests pipe agentProjectRows through rankPaletteItems the same
// way the hook does, using just the arg, and prove rows survive.
describe('agentProjectRows piped through rankPaletteItems with the verb arg', () => {
  function createDeps(): CreateActionDeps {
    return {
      query: '',
      machines: [{ id: 'm1', name: 'home-laptop' }],
      projects: [
        { id: 'p1', name: 'superapps_mabes', machineId: 'm1', path: '~/Documents/freelance/mabes/superapps/core' },
      ],
      sshConnections: [],
      offlineMachineIds: new Set<string>(),
      openBrowser: vi.fn(),
      openSSHConnection: vi.fn(),
      openSSHQuickAdd: vi.fn(),
      openSpawn: vi.fn(),
      openSSHStats: vi.fn(),
    }
  }

  it('yields at least one row for the verb arg that used to render zero rows', () => {
    const rows = agentProjectRows(createDeps(), 'command:agent-new')
    const rankQuery = paletteRankQuery('agent-new mabes', 'mabes', false)
    const groups = rankPaletteItems(rows, rankQuery, () => 0)
    const flat = groups.flatMap((g) => g.items)
    expect(flat.length).toBeGreaterThan(0)
  })

  it('matches a project by a path fragment', () => {
    const rows = agentProjectRows(createDeps(), 'command:agent-new')
    const rankQuery = paletteRankQuery('agent-new freelance', 'freelance', false)
    const groups = rankPaletteItems(rows, rankQuery, () => 0)
    const flat = groups.flatMap((g) => g.items)
    expect(flat.map((r) => r.id)).toContain('command:agent-new:p1')
  })

  it('matches a project by machine name', () => {
    const rows = agentProjectRows(createDeps(), 'command:agent-new')
    const rankQuery = paletteRankQuery('agent-new home-laptop', 'home-laptop', false)
    const groups = rankPaletteItems(rows, rankQuery, () => 0)
    const flat = groups.flatMap((g) => g.items)
    expect(flat.map((r) => r.id)).toContain('command:agent-new:p1')
  })
})

/**
 * Scoring verb rows against the argument is only half the fix. The `ssh` and
 * `browser` rows are not entities being searched — each one *is* the typed
 * command — so matching them against that command has to be a tautology.
 * It can't be left to the title: `deriveSSHQuickAddName` names the row after
 * the target alone, so any flag in the command puts text in the arg that the
 * title does not contain.
 *
 * These pin the `rankPaletteItems` contract the hook's `keywords: [arg]`
 * relies on. They do not exercise the hook's own wiring — this file never
 * renders it — so the two rows are reconstructed here in the hook's shape.
 */
describe('synthesized verb command rows survive their own argument', () => {
  const sshRow = (keywords?: string[]): PaletteItem =>
    item({ id: 'command:ssh', title: 'Connect & save "root@host"', group: 'results', kind: 'command', keywords })

  function survives(row: PaletteItem, arg: string): boolean {
    return rankPaletteItems([row], arg, () => 0).flatMap((g) => g.items).length > 0
  }

  it('is filtered out with no keywords once the command carries a flag', () => {
    expect(survives(sshRow(), 'root@host -J bastion')).toBe(false)
    expect(survives(sshRow(), '-i ~/.ssh/id_rsa root@host')).toBe(false)
  })

  it('survives any argument once that argument is its own keyword', () => {
    for (const arg of ['root@host', 'root@host -J bastion', '-i ~/.ssh/id_rsa root@host', '-p 2222 user@10.0.0.4']) {
      expect(survives(sshRow([arg]), arg)).toBe(true)
    }
  })

  it('keeps a browser row reachable when normalizeUrl rewrote the argument past recognition', () => {
    const row = item({
      id: 'command:browser',
      title: 'https://example.com',
      group: 'results',
      kind: 'url',
      keywords: ['example.com/a b'],
    })
    expect(survives(row, 'example.com/a b')).toBe(true)
  })
})
