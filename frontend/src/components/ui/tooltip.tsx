import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { useRef, useState, type ReactElement } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'

/** Wraps any single trigger element (e.g. an icon button) with a hover/focus label.
 *  `open` is uncontrolled (default: hover/focus, per Base UI) unless the caller passes it
 *  explicitly — e.g. to force the tooltip open as an "armed" confirmation state. */
export function Tooltip({
  label,
  side = 'top',
  open,
  children,
}: {
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  open?: boolean
  children: ReactElement
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open ?? localOpen, popupRef)

  return (
    <BaseTooltip.Root open={open} onOpenChange={setLocalOpen}>
      <BaseTooltip.Trigger delay={150} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} style={{ zIndex: 70 }}>
          <BaseTooltip.Popup
            ref={popupRef}
            className={cn(
              'max-w-[220px] rounded-md border border-devdeck-border-menu bg-devdeck-glass-solid px-2.5 py-1.5 text-[11.5px] leading-snug text-devdeck-fg-2',
              'shadow-[0_12px_30px_rgba(0,0,0,0.5)] transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

/** Small "i" icon that shows explanatory text in a tooltip on hover/focus. */
export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  return (
    <BaseTooltip.Root onOpenChange={setOpen}>
      <BaseTooltip.Trigger
        delay={150}
        render={<button type="button" aria-label="More info" />}
        className={cn('inline-flex cursor-help text-devdeck-fg-2 hover:text-devdeck-fg', className)}
      >
        <Info size={12} />
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={6} style={{ zIndex: 70 }}>
          <BaseTooltip.Popup
            ref={popupRef}
            className={cn(
              'max-w-[220px] rounded-md border border-devdeck-border-menu bg-devdeck-glass-solid px-2.5 py-1.5 text-[11.5px] leading-snug text-devdeck-fg-2',
              'shadow-[0_12px_30px_rgba(0,0,0,0.5)] transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {text}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
