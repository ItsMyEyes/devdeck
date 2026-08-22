import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Download, Loader2, PenLine, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { pickSaveTarget, SAVE_CANCELLED } from '@/lib/saveFile'
import { cn } from '@/lib/utils'
import { useDeleteFileTarget } from '@/features/data/queries'
import { qk } from '@/features/data/keys'
import { useQueryClient } from '@tanstack/react-query'
import type { FilesTarget } from '@/features/terminal/filesTarget'
import { useFileTransfers } from '@/features/terminal/useFileTransfers'
import { MaterialFileIcon } from '@/features/terminal/MaterialFileIcon'
import { documentFormatForPath } from './documentKind'
import { DocumentViewer } from './DocumentViewer'

export interface DocumentFileTabHandle {
  /** Matches FileEditorHandle so the close-tab flow can treat both alike.
   *  A document tab is read-only, so there is never anything to save. */
  save: () => Promise<void>
}

/**
 * A file tab for the formats DevDeck renders instead of editing: PDF, Word,
 * Excel and PowerPoint.
 *
 * Deliberately its own tab shell rather than a body swapped into
 * `FileEditor`/`SSHFileEditor`: those own a text draft, a dirty flag and a
 * save mutation that have no meaning here, and hooks can't be skipped
 * conditionally. Both editors dispatch to this component instead, which keeps
 * the read-only path from ever firing the UTF-8 text fetch that these formats
 * fail. Works against either file source through `FilesTarget`.
 */
export const DocumentFileTab = forwardRef<
  DocumentFileTabHandle,
  {
    target: FilesTarget
    path: string
    active: boolean
    onDirtyChange: (path: string, dirty: boolean) => void
    onDeleted: (path: string) => void
    /** Switches this tab to the text editor. Passed only for the formats that
     *  ARE text (CSV/TSV — see DocumentFormat.textEditable); undefined for
     *  every binary format, which has nothing to edit. */
    onEditAsText?: () => void
  }
>(function DocumentFileTab({ target, path, active, onDirtyChange, onDeleted, onEditAsText }, ref) {
  const format = documentFormatForPath(path)
  const deleteFile = useDeleteFileTarget(target)
  const { downloadFile, downloading } = useFileTransfers(target)
  const queryClient = useQueryClient()

  // Every open file tab stays mounted (inactive ones are just `hidden`), so
  // without this latch restoring a layout with several document tabs would
  // download all of them at once. A one-way latch rather than plain `active`,
  // so switching away mid-download doesn't cancel it.
  const [seen, setSeen] = useState(active)
  useEffect(() => {
    if (active) setSeen(true)
  }, [active])

  useImperativeHandle(ref, () => ({ save: async () => {} }))

  // A document tab can never be dirty, but the pane still tracks one flag per
  // open path — report clean once so a stale entry from a previous editor on
  // the same path can't leave a phantom "unsaved changes" prompt on close.
  useEffect(() => {
    onDirtyChange(path, false)
  }, [onDirtyChange, path])

  const name = path.split('/').pop() ?? path

  async function download() {
    // Picked before awaiting the bytes — showSaveFilePicker needs transient
    // user activation, which expires while a large file downloads.
    const saveTarget = await pickSaveTarget(name)
    if (saveTarget === SAVE_CANCELLED) return
    try {
      const blob = await downloadFile(path, name)
      await saveTarget.write(blob)
      toast.success(`Downloaded ${name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not download ${name}`)
    }
  }

  function refresh() {
    void queryClient.invalidateQueries({
      queryKey:
        target.kind === 'ssh'
          ? qk.sshFileBytes(target.connectionId, path)
          : qk.worktreeFileBytes(target.machine.id, target.worktreeId, path),
    })
  }

  function remove() {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return
    deleteFile.mutate(path, {
      onSuccess: () => {
        toast.success(`Deleted ${name}`)
        onDeleted(path)
      },
    })
  }

  return (
    <div
      className={cn(
        'min-h-0 min-w-0 flex-1 flex-col bg-devdeck-pane',
        active ? 'flex' : 'hidden',
      )}
    >
      <div className="flex h-10 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-pane px-3">
        <MaterialFileIcon name={name} size={16} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">
          {path}
        </span>
        <span className="flex-none rounded bg-devdeck-glass-solid px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
          {format?.label ?? 'Document'} · read-only
        </span>
        {onEditAsText ? (
          <button
            type="button"
            onClick={onEditAsText}
            title="Open this file in the text editor"
            className="flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-2.5 text-[11px] text-devdeck-fg-2 hover:border-devdeck-line hover:text-devdeck-fg"
          >
            <PenLine size={12} />
            Edit as text
          </button>
        ) : null}
        <button
          type="button"
          onClick={refresh}
          title="Reload from disk"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
        >
          <RotateCcw size={13} />
        </button>
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          title="Download file"
          className="flex h-7 items-center gap-1.5 rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-2.5 text-[11px] text-devdeck-fg-2 hover:border-devdeck-line hover:text-devdeck-fg disabled:cursor-default disabled:opacity-40"
        >
          {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          Download
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={deleteFile.isPending}
          title="Delete file"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-red-tint-hover hover:text-devdeck-err disabled:cursor-wait disabled:opacity-50"
        >
          {deleteFile.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      </div>

      {format ? (
        <DocumentViewer target={target} path={path} format={format} enabled={seen} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="font-mono text-[11px] text-devdeck-fg-2">Unsupported document</span>
        </div>
      )}
    </div>
  )
})
