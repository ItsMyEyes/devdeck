import * as React from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'

export const DialogPrimitive = BaseDialog

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  /** max width in px */
  width?: number
  /** stacking level (backdrop + popup) */
  z?: number
  className?: string
}

/** Centered modal card matching the devdeck overlay style. */
export function Dialog({ open, onOpenChange, children, width = 480, z = 60, className }: DialogProps) {
  useNativeOverlayBlocker(open)

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          style={{ zIndex: z }}
          className={cn(
            'fixed inset-0 bg-[rgba(6,7,9,0.62)] backdrop-blur-[3px] transition-opacity duration-150',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <BaseDialog.Popup
          style={{ maxWidth: width, zIndex: z + 1 }}
          className={cn(
            'fixed left-1/2 top-1/2 w-[calc(100vw-36px)] -translate-x-1/2 -translate-y-1/2',
            // Fixed positioning takes the popup out of the page's scroll, so a
            // dialog taller than the window is clipped at *both* edges — the
            // centring translate splits the overflow — with no way to reach
            // either end. Cap it at the viewport and scroll inside instead.
            // `overflow-auto` (the shorthand, not `overflow-y-auto`) so that a
            // dialog managing its own scrolling can drop it with a plain
            // `overflow-hidden` through tailwind-merge.
            'max-h-[calc(100dvh-36px)] overflow-auto',
            'rounded-2xl border border-devdeck-border-menu bg-devdeck-glass-solid p-[21px] text-devdeck-fg outline-none',
            'shadow-[0_24px_60px_rgba(0,0,0,0.55)] transition-all duration-150',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/** Accessible dialog title, rendered as an inline element so features control layout. */
export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title ref={ref} className={cn('text-[15px] font-semibold text-devdeck-fg', className)} {...props} />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description
    ref={ref}
    className={cn('font-mono text-xs text-devdeck-fg-2', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'

export const DialogClose = BaseDialog.Close
