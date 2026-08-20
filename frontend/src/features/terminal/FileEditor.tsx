import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isDocumentPath } from '@/features/documents/documentKind'
import type { Machine } from '@/store/types'
import {
  useDeleteWorktreeFile,
  useWorktreeFile,
  useWriteWorktreeFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import type {
  DefinitionReveal,
  DefinitionTarget,
} from './CodeFileEditor'
import type { LineReveal } from './PlainCodeEditor'

const CodeFileEditor = lazy(() =>
  import('./CodeFileEditor').then((module) => ({
    default: module.CodeFileEditor,
  })),
)

const MarkdownFileEditor = lazy(() =>
  import('./MarkdownFileEditor').then((module) => ({
    default: module.MarkdownFileEditor,
  })),
)

const DocumentFileTab = lazy(() =>
  import('@/features/documents/DocumentFileTab').then((module) => ({
    default: module.DocumentFileTab,
  })),
)

interface FileEditorProps {
  worktreeId: string
  machine: Machine
  path: string
  active: boolean
  onDirtyChange: (path: string, dirty: boolean) => void
  onDeleted: (path: string) => void
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  isPathDirty: (path: string) => boolean
  reveal?: DefinitionReveal
  /** Markdown's "open preview in new tab" button — see MarkdownFileEditor's
   *  `onOpenPreviewTab` doc comment. Unused (and the button hidden) for every
   *  other path. */
  onOpenPreviewTab?: (path: string) => void
}

export interface FileEditorHandle {
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

/** MarkdownFileEditor has no LSP, so it takes a plain line/column reveal
 *  (like the SSH side) rather than CodeFileEditor's LSP-shaped
 *  DefinitionReveal — content search is the only source of a `reveal` that
 *  ever reaches a markdown file (go-to-definition doesn't apply to prose),
 *  and that always sets `range`, never `symbol`. `LineReveal` (Monaco's
 *  shape, from `features/editor/reveal.ts`) is just `{ line, column? }` — no
 *  `length`/`requestId`, unlike the pre-migration CodeMirror-era type. */
function toLineReveal(reveal: DefinitionReveal | undefined): LineReveal | undefined {
  if (!reveal?.range) return undefined
  const { start } = reveal.range
  return {
    line: start.line + 1,
    column: start.character + 1,
  }
}

/**
 * A worktree file tab. Dispatches on the path: PDF/Word/Excel/PowerPoint open
 * as a rendered document, everything else as a text buffer.
 *
 * The split has to happen *here*, above any hook, because the two paths need
 * different data. `TextFileEditor` fetches the file's UTF-8 text, which the
 * backend refuses for these formats (see `WorktreeFileService.Read`), so
 * merely swapping the rendered body would still fire a request that always
 * fails.
 */
export const FileEditor = forwardRef<FileEditorHandle, FileEditorProps>(function FileEditor(
  props,
  ref,
) {
  if (isDocumentPath(props.path)) {
    return (
      <Suspense fallback={<DocumentTabFallback active={props.active} />}>
        <DocumentFileTab
          ref={ref}
          target={{ kind: 'worktree', machine: props.machine, worktreeId: props.worktreeId }}
          path={props.path}
          active={props.active}
          onDirtyChange={props.onDirtyChange}
          onDeleted={props.onDeleted}
        />
      </Suspense>
    )
  }
  return <TextFileEditor {...props} ref={ref} />
})

function DocumentTabFallback({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        'min-h-0 min-w-0 flex-1 items-center justify-center bg-devdeck-pane',
        active ? 'flex' : 'hidden',
      )}
    >
      <DataLoading compact label="loading viewer…" />
    </div>
  )
}

const TextFileEditor = forwardRef<FileEditorHandle, FileEditorProps>(function TextFileEditor(
  {
    worktreeId,
    machine,
    path,
    active,
    onDirtyChange,
    onDeleted,
    onOpenDefinition,
    isPathDirty,
    reveal,
    onOpenPreviewTab,
  },
  ref,
) {
  const [draft, setDraft] = useState('')
  const [initialized, setInitialized] = useState(false)
  const file = useWorktreeFile(machine, worktreeId, path)
  const writeFile = useWriteWorktreeFile(machine, worktreeId)
  const deleteFile = useDeleteWorktreeFile(machine, worktreeId)
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
            reveal={toLineReveal(reveal)}
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
          <CodeFileEditor
            worktreeId={worktreeId}
            machine={machine}
            path={path}
            value={draft}
            ready={initialized}
            onChange={setDraft}
            onOpenDefinition={onOpenDefinition}
            isPathDirty={isPathDirty}
            reveal={reveal}
          />
        </Suspense>
      )}
    </div>
  )
})
