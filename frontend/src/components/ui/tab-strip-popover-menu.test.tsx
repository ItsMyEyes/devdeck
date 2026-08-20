/**
 * Plan Task 4 — `TabStripPopoverMenu` gains an optional controlled `open` /
 * `onOpenChange` pair, threaded straight onto `Popover.Root`'s own
 * controlled/uncontrolled duality. `PanelHeader.tsx` and the DB tab strip
 * pass neither prop and must keep behaving exactly as they do today; a new
 * controlled consumer (Task 9's stash popover) passes both and the popover
 * must stop owning its own truth once it does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import type { TabStripPopoverMenuProps } from '@/components/ui/tab-strip-popover-menu'

afterEach(() => {
  cleanup()
})

function renderMenu(overrides: Partial<TabStripPopoverMenuProps> = {}) {
  return render(
    <TabStripPopoverMenu
      trigger={<span>+</span>}
      triggerTitle="Open menu"
      triggerAriaLabel="Open menu"
      {...overrides}
    >
      <button type="button">Menu item</button>
    </TabStripPopoverMenu>,
  )
}

function triggerButton() {
  return screen.getByRole('button', { name: 'Open menu' })
}

describe('TabStripPopoverMenu — uncontrolled (regression baseline)', () => {
  it('is closed initially and opens on trigger click, with no open/onOpenChange passed', async () => {
    renderMenu()

    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(triggerButton())

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Menu item' })).toBeInTheDocument()
  })
})

describe('TabStripPopoverMenu — controlled', () => {
  it('renders the popup open when open={true} is passed, without any trigger click', () => {
    renderMenu({ open: true, onOpenChange: vi.fn() })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not render the popup when open={false}, even after clicking the trigger — the parent, not the popover, owns truth', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ open: false, onOpenChange })

    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(triggerButton())

    // onOpenChange fired, telling the parent it should open it...
    expect(onOpenChange).toHaveBeenCalledWith(true)
    // ...but since the parent never echoed that back into `open`, a
    // component that were still managing its own internal state would have
    // opened anyway. It must not have.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fires onOpenChange(false) on trigger click while open={true}, but stays visually open until the parent updates', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ open: true, onOpenChange })

    await userEvent.click(triggerButton())

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('fires onOpenChange(false) on outside click while open={true}', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ open: true, onOpenChange })

    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.click(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('fires onOpenChange(false) on Escape while open={true}', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ open: true, onOpenChange })

    await userEvent.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
