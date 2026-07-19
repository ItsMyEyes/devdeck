import * as React from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

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
  const pushNativeOverlayBlocker = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const popNativeOverlayBlocker = useDevDeckStore((s) => s.popNativeOverlayBlocker)

  React.useEffect(() => {
    if (!open) return
    pushNativeOverlayBlocker()
    return () => popNativeOverlayBlocker()
  }, [open, pushNativeOverlayBlocker, popNativeOverlayBlocker])

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
            'rounded-2xl border border-devdeck-border-menu bg-devdeck-card p-[21px] text-devdeck-fg outline-none',
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
    className={cn('font-mono text-xs text-devdeck-dim', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'

export const DialogClose = BaseDialog.Close
