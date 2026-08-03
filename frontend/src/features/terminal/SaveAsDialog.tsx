import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface SaveAsDialogProps {
  open: boolean
  defaultPath: string
  pending: boolean
  onCancel: () => void
  onConfirm: (path: string) => void
}

/** Names an Untitled buffer's first save — the one path-entry prompt an
 *  Untitled tab needs, same shell as ArchiveNameDialog. No folder tree here:
 *  a relative path (e.g. "notes/todo.md") is enough, same convention the old
 *  window.prompt()-based "New file" flow used. */
export function SaveAsDialog({ open, defaultPath, pending, onCancel, onConfirm }: SaveAsDialogProps) {
  const [path, setPath] = useState(defaultPath)

  useEffect(() => {
    if (open) setPath(defaultPath)
  }, [open, defaultPath])

  const canSubmit = path.trim().length > 0 && !pending

  function submit() {
    if (!canSubmit) return
    onConfirm(path.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()} width={420} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <Save size={15} className="text-devdeck-accent-soft" />
        <DialogTitle>Save As</DialogTitle>
      </div>
      <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        Path relative to the worktree root.
      </DialogDescription>
      <Input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="notes/todo.md"
        className="mb-5 font-mono"
        disabled={pending}
        autoFocus
      />
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>
  )
}
