import { useEffect, useMemo, useState } from 'react'
import { Loader2, Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useBookmarks, useCreateBookmark } from '@/features/data/queries'

interface BookmarkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The doc's current machine — fixed, not editable here. Re-pointing a
   *  bookmark at a different machine is a new bookmark, not an edit (see
   *  port.BookmarkPatch's doc comment). */
  machineId: string | null
  machineName: string
  url: string
  initialTitle: string
}

/** Save-a-page dialog for the machine-proxied Browser tile. The favicon isn't
 *  editable here — it's fetched server-side through the owning machine's
 *  proxy once the bookmark is saved (see FaviconService) — so this only
 *  covers the two things the operator actually picks: title and group. */
export function BookmarkDialog({ open, onOpenChange, machineId, machineName, url, initialTitle }: BookmarkDialogProps) {
  const [title, setTitle] = useState(initialTitle)
  const [group, setGroup] = useState('')
  const bookmarks = useBookmarks().data ?? []
  const createBookmark = useCreateBookmark()

  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setGroup('')
  }, [open, initialTitle])

  const groupOptions = useMemo(
    () => Array.from(new Set(bookmarks.map((b) => b.group.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [bookmarks],
  )

  const canSubmit = title.trim().length > 0 && !createBookmark.isPending

  function submit() {
    if (!canSubmit) return
    const cleanTitle = title.trim()
    createBookmark.mutate(
      { machineId: machineId ?? undefined, group: group.trim() || undefined, title: cleanTitle, url },
      {
        onSuccess: () => {
          onOpenChange(false)
          toast.success(`Saved "${cleanTitle}"`)
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save bookmark'),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !createBookmark.isPending && onOpenChange(o)} width={420}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-devdeck-line bg-devdeck-on text-devdeck-fg-2">
          <Star size={16} />
        </div>
        <div className="min-w-0">
          <DialogTitle>Save bookmark</DialogTitle>
          <DialogDescription className="mt-1 truncate">{url}</DialogDescription>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-devdeck-fg-2">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus disabled={createBookmark.isPending} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-devdeck-fg-2">Group</span>
          <Combobox
            value={group}
            onChange={setGroup}
            options={groupOptions}
            placeholder="Portal"
            disabled={createBookmark.isPending}
          />
        </label>
        <div className="text-[10.5px] leading-relaxed text-devdeck-fg-2">
          Saved to <span className="text-devdeck-fg-2">{machineName}</span> - its icon is fetched automatically.
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <DialogClose render={<Button variant="secondary" disabled={createBookmark.isPending} />}>Cancel</DialogClose>
        <Button onClick={submit} disabled={!canSubmit}>
          {createBookmark.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </Dialog>
  )
}
