import { lazy, Suspense, useEffect, useState } from 'react'
import { FileWarning, Loader2, RotateCcw, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDeleteFileTarget, useFileTarget, useWriteFileTarget } from '@/features/data/queries'
import { MarkdownEditor } from '@/features/issues/MarkdownEditor'
import { DataLoading } from '@/features/screens/DataLoading'
import type { FilesTarget } from './filesTarget'
import { MaterialFileIcon } from './MaterialFileIcon'

const PlainCodeEditor = lazy(() =>
  import('./PlainCodeEditor').then((module) => ({ default: module.PlainCodeEditor })),
)

interface SSHFileEditorProps {
  connectionId: string
  path: string
  active: boolean
  onDirtyChange: (path: string, dirty: boolean) => void
  onDeleted: (path: string) => void
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown)$/i.test(path)
}

/** SSH's counterpart to FileEditor.tsx — same chrome (dirty tracking,
 *  save/revert/delete, markdown special-case), but the buffer is a remote
 *  file over SFTP and there is no per-language server, so it renders
 *  PlainCodeEditor instead of the worktree's LSP-backed CodeFileEditor. */
export function SSHFileEditor({ connectionId, path, active, onDirtyChange, onDeleted }: SSHFileEditorProps) {
  const target: FilesTarget = { kind: 'ssh', connectionId }
  const [draft, setDraft] = useState('')
  const [initialized, setInitialized] = useState(false)
  const file = useFileTarget(target, path)
  const writeFile = useWriteFileTarget(target)
  const deleteFile = useDeleteFileTarget(target)
  const dirty = initialized && file.data ? draft !== file.data.content : false

  useEffect(() => {
    if (!file.data || initialized) return
    setDraft(file.data.content)
    setInitialized(true)
  }, [file.data, initialized])

  useEffect(() => {
    onDirtyChange(path, dirty)
  }, [dirty, onDirtyChange, path])

  function save() {
    if (!initialized || writeFile.isPending) return
    writeFile.mutate(
      { path, content: draft },
      { onSuccess: () => toast.success(`Saved ${basename(path)}`) },
    )
  }

  useEffect(() => {
    if (!active) return
    function handleKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })

  function remove() {
    if (!window.confirm(`Delete ${basename(path)}? This cannot be undone.`))
      return
    deleteFile.mutate(path, {
      onSuccess: () => {
        toast.success(`Deleted ${basename(path)}`)
        onDeleted(path)
      },
    })
  }

  return (
    <div
      className={cn(
        'min-h-0 flex-1 flex-col bg-loom-terminal',
        active ? 'flex' : 'hidden',
      )}
    >
      <div className="flex h-10 flex-none items-center gap-2 border-b border-loom-border bg-loom-surface px-3">
        <MaterialFileIcon name={basename(path)} size={16} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-loom-muted">
          {path}
        </span>
        {dirty ? (
          <span className="font-mono text-[9.5px] text-loom-yellow">
            Modified
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => file.data && setDraft(file.data.content)}
          disabled={!dirty || writeFile.isPending}
          title="Revert changes"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg disabled:cursor-default disabled:opacity-30"
        >
          <RotateCcw size={13} />
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || writeFile.isPending}
          title="Save file (Ctrl+S)"
          className="flex h-7 items-center gap-1.5 rounded border border-loom-border-strong bg-loom-elevated px-2.5 text-[11px] text-loom-fg-2 hover:border-loom-border-accent hover:text-loom-accent-soft disabled:cursor-default disabled:opacity-40"
        >
          {writeFile.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Save size={12} />
          )}
          Save
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={deleteFile.isPending}
          title="Delete file"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-red-tint-hover hover:text-loom-red-soft disabled:cursor-wait disabled:opacity-50"
        >
          {deleteFile.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      </div>

      {file.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <DataLoading compact label="loading file…" />
        </div>
      ) : file.error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarning size={22} className="text-loom-yellow" />
          <span className="max-w-lg font-mono text-[11px] leading-relaxed text-loom-muted">
            {file.error instanceof ApiError
              ? file.error.message
              : 'Could not open this file'}
          </span>
          <button
            type="button"
            onClick={() => file.refetch()}
            className="rounded border border-loom-border-strong px-3 py-1.5 text-[11px] text-loom-fg-2 hover:bg-loom-hover-wash"
          >
            Retry
          </button>
        </div>
      ) : isMarkdownPath(path) ? (
        <div className="min-h-0 flex-1 overflow-auto bg-[#090a0c]">
          <div className="w-full px-6 py-8 md:px-10">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder="Empty markdown file. Click to edit."
            />
          </div>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[#090a0c]">
              <DataLoading compact label="loading editor…" />
            </div>
          }
        >
          <PlainCodeEditor path={path} value={draft} onChange={setDraft} />
        </Suspense>
      )}
    </div>
  )
}
