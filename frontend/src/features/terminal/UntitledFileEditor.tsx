import { lazy, Suspense, useEffect, useState } from 'react'
import { FileText, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useWriteFileTarget } from '@/features/data/queries'
import type { FilesTarget } from './filesTarget'
import { SaveAsDialog } from './SaveAsDialog'

const PlainCodeEditor = lazy(() =>
  import('./PlainCodeEditor').then((module) => ({ default: module.PlainCodeEditor })),
)

interface UntitledFileEditorProps {
  target: FilesTarget
  contentId: string
  label: string
  active: boolean
  onDirtyChange: (id: string, dirty: boolean) => void
  /** Fires once the buffer is first written to disk — the caller swaps this
   *  tab for a normal path-backed file tab at `path`. */
  onSaved: (id: string, path: string) => void
}

/** A brand-new, not-yet-saved editor buffer (VS Code's "Untitled-1") — the
 *  counterpart to FileEditor.tsx/SSHFileEditor.tsx for content with no
 *  worktree/SSH path yet. Renders PlainCodeEditor (no LSP — there's no path
 *  to bind a language server to until the first save) and, since there is no
 *  saved baseline to diff against, is considered dirty as soon as it holds
 *  any text at all. */
export function UntitledFileEditor({ target, contentId, label, active, onDirtyChange, onSaved }: UntitledFileEditorProps) {
  const [draft, setDraft] = useState('')
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const writeFile = useWriteFileTarget(target)
  const dirty = draft.length > 0

  useEffect(() => {
    onDirtyChange(contentId, dirty)
  }, [dirty, onDirtyChange, contentId])

  function requestSave() {
    if (writeFile.isPending) return
    setSaveAsOpen(true)
  }

  function confirmSaveAs(path: string) {
    writeFile.mutate(
      { path, content: draft },
      {
        onSuccess: () => {
          setSaveAsOpen(false)
          toast.success(`Saved ${path}`)
          onSaved(contentId, path)
        },
        onError: (error) => {
          toast.error(error instanceof ApiError ? error.message : `Could not save ${path}`)
        },
      },
    )
  }

  useEffect(() => {
    if (!active) return
    function handleKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        requestSave()
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
      <div className="flex h-10 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-pane px-3">
        <FileText size={16} className="text-devdeck-fg-2" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">{label}</span>
        {dirty ? <span className="font-mono text-[9.5px] text-devdeck-yellow">Unsaved</span> : null}
        <button
          type="button"
          onClick={requestSave}
          disabled={writeFile.isPending}
          title="Save (Ctrl+S)"
          className="flex h-7 items-center gap-1.5 rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-2.5 text-[11px] text-devdeck-fg-2 hover:border-devdeck-border-accent hover:text-devdeck-accent disabled:cursor-default disabled:opacity-40"
        >
          {writeFile.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
      </div>

      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center bg-[#090a0c]">
            <Loader2 size={16} className="animate-spin text-devdeck-fg-2" />
          </div>
        }
      >
        <PlainCodeEditor path={label} value={draft} onChange={setDraft} />
      </Suspense>

      <SaveAsDialog
        open={saveAsOpen}
        defaultPath={label}
        pending={writeFile.isPending}
        onCancel={() => setSaveAsOpen(false)}
        onConfirm={confirmSaveAs}
      />
    </div>
  )
}
