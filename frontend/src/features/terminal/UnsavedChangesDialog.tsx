import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export interface UnsavedChangesDialogProps {
  open: boolean
  /** basenames of the file(s) this close would discard changes to */
  names: readonly string[]
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

function bodyFor(names: readonly string[]) {
  if (names.length <= 1) return `"${names[0] ?? ''}" has unsaved changes. They'll be lost if you don't save.`
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? `, +${names.length - 8} more` : ''
  return `${names.length} files have unsaved changes: ${shown}${more}. They'll be lost if you don't save.`
}

/** Save / Don't Save / Cancel — shown before closing a dirty file tab or pane,
 *  instead of blocking the close outright or silently discarding. */
export function UnsavedChangesDialog({ open, names, saving, onSave, onDiscard, onCancel }: UnsavedChangesDialogProps) {
  const title = names.length === 1 ? names[0] : `${names.length} files`
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !saving && onCancel()}
      width={440}
      z={70}
      className="border-devdeck-yellow-tint-border"
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className="text-devdeck-yellow" />
        <DialogTitle>Save changes to {title}?</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        {bodyFor(names)}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onDiscard} disabled={saving}>
          Don&rsquo;t Save
        </Button>
        <Button variant="default" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : null}
          Save{names.length > 1 ? ' All' : ''}
        </Button>
      </div>
    </Dialog>
  )
}
