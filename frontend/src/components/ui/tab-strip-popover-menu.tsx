import { useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'

export interface TabStripPopoverMenuProps {
  trigger: ReactNode
  triggerClassName?: string
  triggerTitle: string
  triggerAriaLabel: string
  /** Spread onto the trigger button. Exists for one caller shape — the guided
   *  tour's `tourAnchor(...)`, when one of its steps highlights a menu button
   *  rather than a plain one. Deliberately not a general prop bag: the trigger
   *  is otherwise wholly owned here, and everything else about it (class,
   *  title, accessible name) already has a named prop. */
  triggerAnchor?: { 'data-tour': string }
  align?: 'start' | 'end'
  /** Stacking level for the popup, mirroring `Dialog`'s `z` prop. Default 60
   *  is correct for a tab strip's own overflow menu, but a caller that opens
   *  this popover from *inside* a `Dialog`/`SideDrawer` must pass a value
   *  above that dialog's `z + 1` (its popup) — otherwise the menu paints
   *  behind the dialog and is invisible/unclickable despite still toggling
   *  open (e.g. FolderBrowser's root switcher, at Dialog z=65). */
  z?: number
  children: ReactNode
  /** Controlled open state. Omitting this (and `onOpenChange`) keeps today's
   *  uncontrolled behaviour — the popover tracks its own open/closed state
   *  via internal `useState`, driven by trigger clicks, outside press, and
   *  Escape. Passing `open` hands truth to the caller instead: the popup's
   *  visibility follows `open` directly (it can be opened without a trigger
   *  click), and `onOpenChange` fires on every transition (trigger click,
   *  outside press, Escape) without this component ever updating its own
   *  state — same controlled/uncontrolled duality as `Popover.Root`'s own
   *  `open` prop, which this threads straight onto. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
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
  triggerAnchor,
  align = 'start',
  z = 60,
  children,
  open: controlledOpen,
  onOpenChange,
}: TabStripPopoverMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const resolvedOpen = controlledOpen ?? internalOpen
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(resolvedOpen, popupRef)

  return (
    <Popover.Root
      open={controlledOpen}
      onOpenChange={(next) => {
        if (!isControlled) setInternalOpen(next)
        onOpenChange?.(next)
      }}
    >
      <Popover.Trigger {...triggerAnchor} className={triggerClassName} title={triggerTitle} aria-label={triggerAriaLabel}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={6} style={{ zIndex: z }} className="outline-none">
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
