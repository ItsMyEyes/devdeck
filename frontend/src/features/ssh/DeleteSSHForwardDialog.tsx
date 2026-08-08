import { Waypoints } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { SSHForward } from '@/store/types'

export function DeleteSSHForwardDialog({
  open,
  rule,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  rule: SSHForward | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const name = rule ? rule.label || `${rule.bindHost}:${rule.bindPort}` : ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={420}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint-hover text-devdeck-err">
          <Waypoints size={17} />
        </div>
        <div>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">
            If it&apos;s running, the forward stops immediately and any connections through it drop.
          </DialogDescription>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <DialogClose render={<Button variant="secondary" disabled={pending} />}>Cancel</DialogClose>
        <Button variant="destructive-solid" disabled={pending} onClick={onConfirm}>
          {pending ? 'Deleting…' : 'Delete forward'}
        </Button>
      </div>
    </Dialog>
  )
}
