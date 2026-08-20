import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/**
 * A destructive-action confirmation, and the in-app replacement for
 * `window.confirm`.
 *
 * `window.confirm` cannot be used in this app: the Tauri desktop build's
 * WKWebView implements no `runJavaScriptConfirmPanelWithMessage` delegate, so
 * it returns `false` immediately without ever showing a dialog. Every caller
 * shaped like `if (!window.confirm(...)) return` therefore returns early on
 * every invocation — the action silently never runs, with nothing on screen to
 * explain why. `TerminalExplorer.tsx` documents the identical defect for
 * `window.prompt` and its own delegate.
 *
 * Modelled on `RemoveSkillDialog`, generalised because the same silent no-op
 * affects every remaining `window.confirm` call site in this codebase.
 */
export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  /** The destructive button's label, e.g. `Delete session`. */
  confirmLabel: string
  /** Shown in its place while the action is in flight. Defaults to
   *  `confirmLabel`, so a caller that does not track pending state still gets
   *  a coherent button. */
  pendingLabel?: string
  pending?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={440}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-devdeck-red-tint-strong-border bg-devdeck-red-tint text-devdeck-err">
          <AlertTriangle size={17} />
        </div>
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className="mt-1.5 leading-relaxed">{description}</DialogDescription>
          ) : null}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <DialogClose render={<Button variant="secondary" disabled={pending} />}>Cancel</DialogClose>
        {/* Disabled while pending, not merely relabelled: a destructive action
            fired twice hits an id that no longer exists on the second run. */}
        <Button variant="destructive-solid" disabled={pending} onClick={onConfirm}>
          {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
