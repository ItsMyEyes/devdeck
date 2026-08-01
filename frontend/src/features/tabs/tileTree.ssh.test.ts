import { describe, expect, it } from 'vitest'
import { closeTileTab, createDefaultTileLayout, createSSHShellTab, findTileLeaf, openTileTab } from './tileTree'

describe('tileTree ssh-shell tab kind', () => {
  it('createSSHShellTab derives a stable id from the connection id', () => {
    const tab = createSSHShellTab('sc-1a2b3c4d')
    expect(tab.kind).toBe('ssh-shell')
    if (tab.kind !== 'ssh-shell') throw new Error('expected an ssh-shell tab')
    expect(tab.id).toBe('ssh-sc-1a2b3c4d')
    expect(tab.connectionId).toBe('sc-1a2b3c4d')
  })

  it('openTileTab adds an ssh-shell tab and makes it active', () => {
    const layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
    const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
    expect(leaf?.type).toBe('leaf')
    if (leaf?.type !== 'leaf') throw new Error('expected a leaf')
    expect(leaf.tabs.some((t) => t.id === 'ssh-sc-1')).toBe(true)
    expect(leaf.activeTabId).toBe('ssh-sc-1')
  })

  it('re-opening the same connection focuses the existing tab instead of duplicating', () => {
    let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
    layout = openTileTab(layout, createSSHShellTab('sc-1'))
    const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
    expect(leaf?.type).toBe('leaf')
    if (leaf?.type !== 'leaf') throw new Error('expected a leaf')
    const sshTabs = leaf.tabs.filter((t) => t.kind === 'ssh-shell')
    expect(sshTabs.length).toBe(1)
  })

  it('closeTileTab removes an ssh-shell tab', () => {
    let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
    const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
    expect(leaf?.type).toBe('leaf')
    if (leaf?.type !== 'leaf') throw new Error('expected a leaf')
    layout = closeTileTab(layout, leaf.id, 'ssh-sc-1')
    const after = findTileLeaf(layout.root, layout.focusedLeafId)
    expect(after?.type === 'leaf' && !after.tabs.some((t) => t.id === 'ssh-sc-1')).toBe(true)
  })
})
