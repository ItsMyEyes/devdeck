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

import { Dialog, DialogTitle } from '@/components/ui/dialog'
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

/** The stacking level an element actually paints at: the nearest inline
 *  `z-index` at or above it. Both surfaces set theirs as an inline style —
 *  `Dialog` on the popup itself, `TabStripPopoverMenu` on the positioner that
 *  wraps its popup — so one walk answers for both. */
function stackingLevelOf(from: Element | null | undefined): number {
  for (let el = from as HTMLElement | null; el; el = el.parentElement) {
    if (el.style?.zIndex) return Number(el.style.zIndex)
  }
  throw new Error('no inline z-index found at or above this element')
}

describe('TabStripPopoverMenu — stacking level', () => {
  it('defaults to 60, which is right for a tab strip on the page', () => {
    renderMenu({ open: true, onOpenChange: vi.fn() })
    expect(stackingLevelOf(screen.getByRole('dialog'))).toBe(60)
  })

  it('can be lifted above a Dialog it is opened from inside', () => {
    // FolderBrowser's drive/root switcher, which is what this prop exists for.
    // Its `Dialog z={65}` paints a backdrop at 65 and the card at 66, so the
    // popover's default 60 put the menu UNDER the very dialog that owns it:
    // clicking the drive button toggled a menu nobody could see or click, and
    // the only symptom was a button that appeared to do nothing.
    render(
      <Dialog open onOpenChange={() => {}} z={65}>
        <DialogTitle>Choose a folder</DialogTitle>
        <TabStripPopoverMenu
          trigger={<span>drive</span>}
          triggerTitle="Switch drive or root"
          triggerAriaLabel="Switch drive or root"
          z={70}
          open
          onOpenChange={vi.fn()}
        >
          <button type="button">D:\</button>
        </TabStripPopoverMenu>
      </Dialog>,
    )

    const menu = stackingLevelOf(screen.getByRole('button', { name: 'D:\\' }))
    const dialogCard = stackingLevelOf(screen.getByText('Choose a folder'))

    // Asserted as a relationship, not against the literal 66: the guard is
    // "the menu wins", and it must survive either surface changing its number.
    expect(menu).toBeGreaterThan(dialogCard)
  })
})
