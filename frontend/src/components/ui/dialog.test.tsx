import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Dialog, DialogTitle } from '@/components/ui/dialog'

afterEach(cleanup)

function popup() {
  return screen.getByRole('dialog')
}

describe('Dialog popup sizing', () => {
  it('caps its height at the viewport and scrolls the overflow', () => {
    // The popup is `position: fixed` and centred with a -50% translate, so
    // without a height cap a tall dialog grows past both edges of the viewport
    // at once. There is no ancestor scroll container to reach the clipped parts
    // with — the content has to scroll inside the popup itself.
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogTitle>Editor dependencies</DialogTitle>
      </Dialog>,
    )
    const className = popup().className
    expect(className).toMatch(/max-h-\[/)
    expect(className).toMatch(/overflow-auto/)
  })

  it('lets a dialog that manages its own scrolling opt out', () => {
    // DesktopSettingsDialog and SkillContentDialog set a fixed height and put
    // the scroll on an inner pane; tailwind-merge has to drop the base
    // `overflow-auto` rather than leave two competing overflow rules.
    render(
      <Dialog open onOpenChange={() => {}} className="h-[min(620px,82vh)] overflow-hidden p-0">
        <DialogTitle>Settings</DialogTitle>
      </Dialog>,
    )
    const className = popup().className
    expect(className).toContain('overflow-hidden')
    expect(className).not.toContain('overflow-auto')
  })
})
