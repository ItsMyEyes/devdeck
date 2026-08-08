import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { paneControlsFor, TileTabButton } from './WorkspaceTileCanvas'

afterEach(() => {
  cleanup()
})

// Matched against the real `TileTabButton` prop type at
// WorkspaceTileCanvas.tsx: `compact` is required (no default), and
// `shortcutNumber` / `onClose` are optional so they are omitted here.
const base = {
  leafId: 'leaf-1',
  tab: { kind: 'agents', id: 'agents' } as const,
  compact: false,
  resolveWorktreeTab: () => undefined,
  resolveBrowserTab: () => ({ label: 'Web' }),
  resolveSSHShellTab: () => ({ label: 'SSH' }),
  onSelect: () => {},
}

describe('active state', () => {
  // The bottom accent bar (`data-active-bar`) was removed: selection now
  // reads through the wash alone, on every surface, regardless of which
  // leaf has keyboard focus — see TileTabButton's `stateMarkers` doc comment.
  it('marks the active tab as selected regardless of leaf focus', () => {
    const { container } = render(<TileTabButton {...base} active focused />)
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull()
    expect(container.querySelector('[data-active-bar]')).toBeNull()
  })

  it('keeps the selected marker when the leaf is not focused', () => {
    const { container } = render(<TileTabButton {...base} active focused={false} />)
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull()
    expect(container.querySelector('[data-active-bar]')).toBeNull()
  })

  it('omits the selected marker on an inactive tab', () => {
    const { container } = render(<TileTabButton {...base} active={false} focused />)
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
    expect(container.querySelector('[data-active-bar]')).toBeNull()
  })
})

describe('paneControlsFor', () => {
  it('keeps every control inline at a comfortable width', () => {
    expect(paneControlsFor(600)).toEqual({
      inline: ['split-h', 'split-v', 'more', 'close'],
      overflow: [],
    })
  })

  it('collapses everything but close below 260px', () => {
    // At quarter width in a 2x2 split the controls consume as much room as
    // the tab label itself.
    expect(paneControlsFor(259)).toEqual({
      inline: ['more', 'close'],
      overflow: ['split-h', 'split-v'],
    })
  })

  it('treats 260 as comfortable, not narrow', () => {
    expect(paneControlsFor(260).overflow).toEqual([])
  })
})

describe('paneControlsFor below md', () => {
  it('offers no split controls at all on a phone, at any width', () => {
    // A 2x2 grid at 390px produces nothing readable, so the affordance is
    // removed rather than left to disappoint.
    const result = paneControlsFor(390, false)
    expect(result.inline).toEqual(['more', 'close'])
    expect(result.overflow).toEqual([])
  })

  it('still offers splits on a narrow desktop pane, via overflow', () => {
    expect(paneControlsFor(200, true).overflow).toEqual(['split-h', 'split-v'])
  })
})
