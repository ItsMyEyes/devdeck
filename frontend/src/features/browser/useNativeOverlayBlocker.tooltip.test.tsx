import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tooltip } from '@/components/ui/tooltip'
import { visibleTileRect } from '@/features/browser/visibleTileRect'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function blockers() {
  return useDevDeckStore.getState().nativeOverlayBlockers
}

describe('Tooltip overlay blocker scoping', () => {
  beforeEach(() => {
    for (const id of Object.keys(blockers())) {
      useDevDeckStore.getState().popNativeOverlayBlocker(id)
    }
  })

  // Base UI reports the tooltip open a commit before it commits the portalled
  // popup, so the blocker hook first sees a null `rectRef.current`. Resolving
  // that to `'viewport'` — which `visibleTileRect` short-circuits on — meant
  // hovering any tooltip anywhere blanked every open Browser tile, and the
  // effect never re-ran to correct itself once the popup landed.
  it('scopes the blocker to the popup rect once it mounts, never viewport-wide', async () => {
    render(
      <Tooltip label="New agent in core">
        <button type="button">new agent</button>
      </Tooltip>,
    )

    await userEvent.hover(screen.getByRole('button', { name: 'new agent' }))

    await waitFor(() => expect(Object.keys(blockers())).toHaveLength(1), { timeout: 3000 })
    const region = Object.values(blockers())[0]
    expect(region).not.toBe('viewport')
    expect(region).toMatchObject({
      left: expect.any(Number),
      top: expect.any(Number),
      right: expect.any(Number),
      bottom: expect.any(Number),
    })

    // The consequence that was actually visible: a Browser tile the tooltip
    // does not overlap must keep its webview on screen. jsdom measures every
    // element as 0x0, so the popup's own rect is degenerate — stand a tile far
    // away from it to assert the tile survives a blocker that misses it.
    const tile = { left: 1000, top: 60, right: 1900, bottom: 1200 }
    expect(visibleTileRect(tile, blockers(), false)).toEqual(tile)
  })

  it('drops the blocker again when the pointer leaves', async () => {
    render(
      <Tooltip label="New agent in core">
        <button type="button">new agent</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'new agent' })
    await userEvent.hover(trigger)
    await waitFor(() => expect(Object.keys(blockers())).toHaveLength(1), { timeout: 3000 })

    await userEvent.unhover(trigger)
    await waitFor(() => expect(Object.keys(blockers())).toHaveLength(0), { timeout: 3000 })
  })
})
