import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Wraps any single trigger element (e.g. an icon button) with a hover/focus label. */
export function Tooltip({
  label,
  side = 'top',
  children,
}: {
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} style={{ zIndex: 70 }}>
          <BaseTooltip.Popup
            className={cn(
              'max-w-[220px] rounded-md border border-loom-border-menu bg-loom-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-loom-fg-2',
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
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        render={<button type="button" aria-label="More info" />}
        className={cn('inline-flex cursor-help text-loom-dim hover:text-loom-accent-soft', className)}
      >
        <Info size={12} />
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={6} style={{ zIndex: 70 }}>
          <BaseTooltip.Popup
            className={cn(
              'max-w-[220px] rounded-md border border-loom-border-menu bg-loom-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-loom-fg-2',
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
