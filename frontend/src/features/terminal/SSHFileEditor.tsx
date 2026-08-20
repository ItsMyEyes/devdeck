import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isDocumentPath } from '@/features/documents/documentKind'
import { useDeleteFileTarget, useFileTarget, useWriteFileTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import type { FilesTarget } from './filesTarget'
import type { LineReveal } from './PlainCodeEditor'

const PlainCodeEditor = lazy(() =>
  import('./PlainCodeEditor').then((module) => ({ default: module.PlainCodeEditor })),
)

const MarkdownFileEditor = lazy(() =>
  import('./MarkdownFileEditor').then((module) => ({ default: module.MarkdownFileEditor })),
)

const DocumentFileTab = lazy(() =>
  import('@/features/documents/DocumentFileTab').then((module) => ({
    default: module.DocumentFileTab,
  })),
)

interface SSHFileEditorProps {
  connectionId: string
  path: string
  active: boolean
  onDirtyChange: (path: string, dirty: boolean) => void
  onDeleted: (path: string) => void
  /** Content search's "open at line" entry point — see PlainCodeEditor.tsx's LineReveal doc comment. */
  reveal?: LineReveal
  /** Markdown's "open preview in new tab" button — see MarkdownFileEditor's
   *  `onOpenPreviewTab` doc comment. Unused (and the button hidden) for every
   *  other path. */
  onOpenPreviewTab?: (path: string) => void
}

export interface SSHFileEditorHandle {
  /** Writes the current draft, resolving once saved or rejecting if the write
   *  fails — used by the close-tab "Save" action, which needs to know
   *  whether it's safe to actually close. No-ops if there's nothing dirty. */
  save: () => Promise<void>
  /** Discards the draft, restoring the last-saved content — the pane
   *  overflow menu's "Revert file" action. Optional: a read-only tab (e.g.
   *  DocumentFileTab, dispatched to below) has nothing to revert. */
  revert?: () => void
  /** Deletes this file from disk after a confirm prompt — the pane overflow
   *  menu's "Delete file" action. Optional for the same reason as `revert`. */
  remove?: () => void
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
 *  PlainCodeEditor instead of the worktree's LSP-backed CodeFileEditor.
 *
 *  Documents (PDF/Word/Excel/PowerPoint) branch off above every hook for the
 *  same reason FileEditor.tsx does — see that file's dispatch comment. */
export const SSHFileEditor = forwardRef<SSHFileEditorHandle, SSHFileEditorProps>(function SSHFileEditor(
  props,
  ref,
) {
  if (isDocumentPath(props.path)) {
    return (
      <Suspense
        fallback={
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 items-center justify-center bg-devdeck-pane',
              props.active ? 'flex' : 'hidden',
            )}
          >
            <DataLoading compact label="loading viewer…" />
          </div>
        }
      >
        <DocumentFileTab
          ref={ref}
          target={{ kind: 'ssh', connectionId: props.connectionId }}
          path={props.path}
          active={props.active}
          onDirtyChange={props.onDirtyChange}
          onDeleted={props.onDeleted}
        />
      </Suspense>
    )
  }
  return <SSHTextFileEditor {...props} ref={ref} />
})

const SSHTextFileEditor = forwardRef<SSHFileEditorHandle, SSHFileEditorProps>(function SSHTextFileEditor(
  { connectionId, path, active, onDirtyChange, onDeleted, reveal, onOpenPreviewTab },
  ref,
) {
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

  async function saveNow() {
    if (!initialized || !dirty) return
    await writeFile.mutateAsync({ path, content: draft })
    toast.success(`Saved ${basename(path)}`)
  }

  function save() {
    if (!initialized || writeFile.isPending) return
    void saveNow().catch(() => undefined)
  }

  function revert() {
    if (!dirty || writeFile.isPending || !file.data) return
    setDraft(file.data.content)
  }

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

  useImperativeHandle(ref, () => ({ save: saveNow, revert, remove }))

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

  return (
    <div
      className={cn(
        'min-h-0 min-w-0 flex-1 flex-col bg-devdeck-pane',
        active ? 'flex' : 'hidden',
      )}
    >
      {file.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <DataLoading compact label="loading file…" />
        </div>
      ) : file.error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarning size={22} className="text-devdeck-yellow" />
          <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
            {file.error instanceof ApiError
              ? file.error.message
              : 'Could not open this file'}
          </span>
          <button
            type="button"
            onClick={() => file.refetch()}
            className="rounded border border-devdeck-border-strong px-3 py-1.5 text-[11px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash"
          >
            Retry
          </button>
        </div>
      ) : isMarkdownPath(path) ? (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[#090a0c]">
              <DataLoading compact label="loading editor…" />
            </div>
          }
        >
          <MarkdownFileEditor
            path={path}
            value={draft}
            ready={initialized}
            onChange={setDraft}
            reveal={reveal}
            onOpenPreviewTab={onOpenPreviewTab}
          />
        </Suspense>
      ) : (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[#090a0c]">
              <DataLoading compact label="loading editor…" />
            </div>
          }
        >
          <PlainCodeEditor path={path} value={draft} ready={initialized} onChange={setDraft} reveal={reveal} />
        </Suspense>
      )}
    </div>
  )
})
