import { useEffect, useState } from 'react'
import { FileArchive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { normalizeArchiveName } from './archiveName'

export interface ArchiveNameDialogProps {
  open: boolean
  defaultName: string
  itemCount: number
  pending: boolean
  onCancel: () => void
  onConfirm: (filename: string) => void
}

export function ArchiveNameDialog({
  open,
  defaultName,
  itemCount,
  pending,
  onCancel,
  onConfirm,
}: ArchiveNameDialogProps) {
  const [name, setName] = useState(defaultName)

  // Re-seed on every open: the dialog stays mounted between uses, so a name
  // typed for the previous selection would otherwise stick around.
  useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])

  const canSubmit = name.trim().length > 0 && !pending

  function submit() {
    if (!canSubmit) return
    onConfirm(normalizeArchiveName(name))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()} width={400} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <FileArchive size={15} className="text-devdeck-accent-soft" />
        <DialogTitle>Download archive</DialogTitle>
      </div>
      <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        Zips {itemCount} item{itemCount === 1 ? '' : 's'}. Name the archive before it's built.
      </DialogDescription>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={defaultName}
        className="mb-5 font-mono"
        disabled={pending}
        autoFocus
      />
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {pending ? 'Zipping…' : 'Download'}
        </Button>
      </div>
    </Dialog>
  )
}
