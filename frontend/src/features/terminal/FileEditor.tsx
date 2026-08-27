import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { documentFormatForPath } from '@/features/documents/documentKind'
import type { Machine } from '@/store/types'
import {
  useDeleteWorktreeFile,
  useWorktreeFile,
  useWriteWorktreeFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { ExternalChangeBar } from './ExternalChangeBar'
import { editBuffer, hasExternalChange, seedBuffer, syncBuffer } from './fileBuffer'
import type { FileBuffer } from './fileBuffer'
import { useFileAutoSave } from './useFileAutoSave'
import type {
  DefinitionReveal,
  DefinitionTarget,
} from './CodeFileEditor'
import type { LineReveal } from './PlainCodeEditor'
import { matchesBinding } from '@/features/keybindings/store'

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
  /** Abandons the draft: cancels any pending auto-save and stops this tab
   *  writing again. Called by `cleanupFileBookkeeping` on every path that takes
   *  a tab away, because "Don't Save" and "the file was deleted" both unmount a
   *  still-dirty editor whose unmount flush would otherwise put the discarded
   *  draft back. See `useFileAutoSave` for why it has to be imperative.
   *  Optional: a read-only document tab never auto-saves. */
  discard?: () => void
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
 * A worktree file tab. Dispatches on the path: PDF/Word/Excel/PowerPoint, CSV,
 * images and video open as a rendered document; everything else as a text
 * buffer.
 *
 * The split has to happen *here*, above the body, because the two paths need
 * different data. `TextFileEditor` fetches the file's UTF-8 text, which the
 * backend refuses for the binary formats (see `WorktreeFileService.Read`), so
 * merely swapping the rendered body would still fire a request that always
 * fails.
 *
 * `asText` is the one way back for a format that IS text — today only CSV/TSV.
 * It lives here rather than inside the document tab because switching views
 * means mounting a completely different tab, and only this component can do
 * that. Keyed on nothing: `useState` runs unconditionally, before the branch,
 * so the rule about hooks still holds.
 */
export const FileEditor = forwardRef<FileEditorHandle, FileEditorProps>(function FileEditor(
  props,
  ref,
) {
  const [asText, setAsText] = useState(false)
  const format = documentFormatForPath(props.path)

  if (format && !asText) {
    return (
      <Suspense fallback={<DocumentTabFallback active={props.active} />}>
        <DocumentFileTab
          ref={ref}
          target={{ kind: 'worktree', machine: props.machine, worktreeId: props.worktreeId }}
          path={props.path}
          active={props.active}
          onDirtyChange={props.onDirtyChange}
          onDeleted={props.onDeleted}
          onEditAsText={format.textEditable ? () => setAsText(true) : undefined}
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
  // `buffer` replaces the load-once `draft`/`initialized` pair: the file is
  // re-read while the tab is on screen, and `fileBuffer.ts` owns the rule for
  // when a fresh read may replace what the editor shows. See that module for
  // why a one-shot latch was both deliberate and wrong.
  const [buffer, setBuffer] = useState<FileBuffer | null>(null)
  const file = useWorktreeFile(machine, worktreeId, path, { live: active })
  const writeFile = useWriteWorktreeFile(machine, worktreeId)
  const deleteFile = useDeleteWorktreeFile(machine, worktreeId)
  const content = file.data?.content
  // Reconciled during render, not only in the effect below. `dirty` is derived
  // from the buffer, so letting the commit lag a frame behind the query would
  // report every adopted write as an unsaved change for one render — a tab dot
  // blinking on and off for as long as an agent keeps writing. `syncBuffer` is
  // pure and idempotent, so calling it here costs nothing and the effect stays
  // the thing that actually commits.
  const synced = content === undefined ? buffer : syncBuffer(buffer, content)
  const draft = synced?.draft ?? ''
  const initialized = synced !== null
  const dirty = initialized && content !== undefined ? draft !== content : false
  const externallyChanged = hasExternalChange(synced, content)

  useEffect(() => {
    if (content === undefined) return
    setBuffer((current) => syncBuffer(current, content))
  }, [content])

  const setDraft = useCallback((next: string) => {
    setBuffer((current) => editBuffer(current, next))
  }, [])

  // Bringing a tab to the front is the operator asking to look at this file, so
  // answer with what is on disk now rather than making them wait out the poll
  // interval. Only on the false->true edge: the mount fetch already covers a
  // tab that opens active.
  const wasActive = useRef(active)
  const refetch = file.refetch
  useEffect(() => {
    const becameActive = active && !wasActive.current
    wasActive.current = active
    if (becameActive) void refetch()
  }, [active, refetch])

  useEffect(() => {
    onDirtyChange(path, dirty)
  }, [dirty, onDirtyChange, path])

  /** `silent` is the auto-save path: a toast per write turns a background
   *  convenience into a stream of notifications. Failures still surface — see
   *  `useFileAutoSave`. */
  async function saveNow(options?: { silent?: boolean }) {
    if (!initialized || !dirty) return
    await writeFile.mutateAsync({ path, content: draft })
    if (!options?.silent) toast.success(`Saved ${basename(path)}`)
  }

  function save() {
    if (!initialized || writeFile.isPending) return
    void saveNow().catch(() => undefined)
  }

  const discardAutoSave = useFileAutoSave({
    ready: initialized,
    active,
    dirty,
    draft,
    conflicted: externallyChanged,
    save: () => saveNow({ silent: true }),
  })

  /** Discards local edits — the overflow menu's "Revert file" and, when the
   *  file moved underneath them, ExternalChangeBar's "Reload from disk". Both
   *  mean the same thing: take what the server has. */
  function revert() {
    if (!dirty || writeFile.isPending || content === undefined) return
    setBuffer(seedBuffer(content))
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

  useImperativeHandle(ref, () => ({
    save: () => saveNow(),
    revert,
    remove,
    discard: discardAutoSave,
  }))

  useEffect(() => {
    if (!active) return
    function handleKeydown(event: KeyboardEvent) {
      if (matchesBinding(event, 'editor.save')) {
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
      ) : (
        <>
          {externallyChanged ? <ExternalChangeBar onReload={revert} /> : null}
          {isMarkdownPath(path) ? (
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
        </>
      )}
    </div>
  )
})
