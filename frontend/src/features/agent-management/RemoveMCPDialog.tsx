import { ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

export function RemoveMCPDialog({
  open,
  serverName,
  agentName,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  serverName: string
  agentName: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={420}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint-hover text-devdeck-red-soft">
          <ServerOff size={17} />
        </div>
        <div>
          <DialogTitle>Remove {serverName}?</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">
            The server will be removed from {agentName}&apos;s native MCP configuration.
          </DialogDescription>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <DialogClose render={<Button variant="secondary" disabled={pending} />}>
          Cancel
        </DialogClose>
        <Button variant="destructive-solid" disabled={pending} onClick={onConfirm}>
          {pending ? 'Removing...' : 'Remove server'}
        </Button>
      </div>
    </Dialog>
  )
}
