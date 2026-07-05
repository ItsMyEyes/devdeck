import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

export function RemoveSkillDialog({
  open,
  agentName,
  skillName,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  agentName: string
  skillName: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={440}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-loom-yellow-tint-border bg-loom-yellow-tint text-loom-yellow">
          <AlertTriangle size={17} />
        </div>
        <div className="min-w-0">
          <DialogTitle>Remove {skillName}?</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">
            This removes the skill from {agentName}. Linked skills are detached immediately. Local
            skill folders are moved to Loom&apos;s trash when possible.
          </DialogDescription>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <DialogClose
          render={<Button variant="secondary" disabled={pending} />}
        >
          Cancel
        </DialogClose>
        <Button variant="destructive-solid" disabled={pending} onClick={onConfirm}>
          {pending ? 'Removing...' : 'Remove skill'}
        </Button>
      </div>
    </Dialog>
  )
}
