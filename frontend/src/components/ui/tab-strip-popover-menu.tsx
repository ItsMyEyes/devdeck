import { useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'

export interface TabStripPopoverMenuProps {
  trigger: ReactNode
  triggerClassName?: string
  triggerTitle: string
  triggerAriaLabel: string
  align?: 'start' | 'end'
  children: ReactNode
}

/** Shared popover shell for a tab strip's "..." overflow menu and "+"
 *  new-tab menu — used by both the terminal's PanelHeader and the database
 *  module's DBTabStrip. Purely presentational: the caller owns the trigger
 *  icon and the menu content, this component only owns positioning/styling. */
export function TabStripPopoverMenu({
  trigger,
  triggerClassName,
  triggerTitle,
  triggerAriaLabel,
  align = 'start',
  children,
}: TabStripPopoverMenuProps) {
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  return (
    <Popover.Root onOpenChange={setOpen}>
      <Popover.Trigger className={triggerClassName} title={triggerTitle} aria-label={triggerAriaLabel}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
          <Popover.Popup
            ref={popupRef}
            className={cn(
              'min-w-[150px] origin-[var(--transform-origin)] rounded-control border border-devdeck-border-menu bg-devdeck-glass-solid p-1.5',
              'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
