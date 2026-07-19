import { useEffect, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

interface SideDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  width?: number
  z?: number
  className?: string
}

/** Right-anchored settings drawer (worktree / project / workspace details). */
export function SideDrawer({ open, onOpenChange, children, width = 380, z = 50, className }: SideDrawerProps) {
  const pushNativeOverlayBlocker = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const popNativeOverlayBlocker = useDevDeckStore((s) => s.popNativeOverlayBlocker)

  useEffect(() => {
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
            'fixed inset-0 bg-[rgba(6,7,9,0.5)] transition-opacity duration-150',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <BaseDialog.Popup
          style={{ width, maxWidth: '92vw', zIndex: z + 1 }}
          className={cn(
            'fixed inset-y-0 right-0 flex flex-col border-l border-devdeck-border-strong bg-devdeck-surface-2 text-devdeck-fg outline-none',
            'shadow-[-12px_0_44px_rgba(0,0,0,0.55)] transition-transform duration-200 ease-out',
            'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
            className,
          )}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
