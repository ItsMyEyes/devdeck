import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from '@/components/ui/select'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function blockerRegions() {
  return Object.values(useDevDeckStore.getState().nativeOverlayBlockers)
}

describe('Select overlay blocker scoping', () => {
  beforeEach(() => {
    for (const id of Object.keys(useDevDeckStore.getState().nativeOverlayBlockers)) {
      useDevDeckStore.getState().popNativeOverlayBlocker(id)
    }
  })

  // A `'viewport'` blocker hides EVERY open Browser tile unconditionally
  // (`tileShouldBeHidden` short-circuits on it), so a dropdown that resolves to
  // one blanks the whole page instead of just the strip it covers.
  it('pushes a rect-scoped blocker for the open popup, never a viewport-wide one', async () => {
    render(
      <Select
        value="a"
        onValueChange={() => undefined}
        options={[
          { value: 'a', label: 'home-laptop' },
          { value: 'b', label: 'test-runtime-9199' },
        ]}
        aria-label="Machine"
      />,
    )

    await userEvent.click(screen.getByLabelText('Machine'))

    await waitFor(() => expect(blockerRegions().length).toBeGreaterThan(0))
    expect(blockerRegions()).not.toContain('viewport')
  })
})
