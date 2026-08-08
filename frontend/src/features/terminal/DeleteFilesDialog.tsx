import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export interface DeleteFilesDialogProps {
  open: boolean
  names: readonly string[]
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

function bodyFor(names: readonly string[]) {
  if (names.length <= 1) return `This deletes "${names[0] ?? ''}". This cannot be undone.`
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? `, +${names.length - 8} more` : ''
  return `This deletes ${names.length} items: ${shown}${more}. This cannot be undone.`
}

export function DeleteFilesDialog({ open, names, pending, onCancel, onConfirm }: DeleteFilesDialogProps) {
  const title = names.length === 1 ? names[0] : `${names.length} items`
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()} width={400} z={70} className="border-devdeck-red-tint">
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className="text-devdeck-err" />
        <DialogTitle>Delete {title}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
        {bodyFor(names)}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="destructive-solid" onClick={onConfirm} disabled={pending}>
          Delete
        </Button>
      </div>
    </Dialog>
  )
}
