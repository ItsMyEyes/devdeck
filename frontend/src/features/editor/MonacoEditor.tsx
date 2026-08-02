import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor'
import { monaco, setupMonaco } from './monacoSetup'
import { buildEditorOptions } from './editorOptions'
import { useVsCodeMode } from './useVsCodeMode'
import { languageForPath } from './languageForPath'
import { createModelRegistry } from './modelRegistry'
import { toMonacoRange, type EditorReveal } from './reveal'
import { cn } from '@/lib/utils'

setupMonaco()

/** One registry for the whole app — see modelRegistry.ts for why models must
 *  outlive the React components that display them. */
const models = createModelRegistry({
  createModel: (value, language, uri) =>
    monaco.editor.createModel(value, language, uri as monaco.Uri),
})

export interface MonacoEditorProps {
  path: string
  value: string
  onChange?: (value: string) => void
  /** True once `value` is the file's real, loaded content rather than the empty
   *  placeholder rendered while a fetch is in flight. The reveal effect gates on
   *  this rather than on `value` — see the effect below. */
  ready?: boolean
  reveal?: EditorReveal
  readOnly?: boolean
  language?: string
  /** Stable identity for the underlying model. Defaults to `path`; worktree and
   *  SSH surfaces pass `machine:worktree:path` so two machines can have the same
   *  relative path open at once. */
  modelKey?: string
  options?: editor.IStandaloneEditorConstructionOptions
  /** Runs once the editor instance exists. May return a cleanup function — this
   *  is where LSP wiring, custom actions and keybindings attach. */
  onMount?: (instance: editor.IStandaloneCodeEditor) => void | (() => void)
  ariaLabel?: string
  className?: string
}

export function MonacoEditor({
  path,
  value,
  onChange,
  ready = true,
  reveal,
  readOnly = false,
  language,
  modelKey,
  options,
  onMount,
  ariaLabel,
  className,
}: MonacoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [vscodeMode] = useVsCodeMode()
  // Monaco builds its instance inside a layout effect, so on a freshly mounted
  // tab `editorRef.current` is still null when the reveal effect below first
  // runs. Bumping this once the instance exists re-runs that effect, rather than
  // relying on an incidental extra render.
  const [mounted, setMounted] = useState(false)

  const key = modelKey ?? path
  const resolvedLanguage = language ?? languageForPath(path)

  // Latest-value refs: the mount effect must run exactly once per key, so it
  // cannot close over props that change on every keystroke.
  const latest = useRef({ onChange, onMount, options, vscodeMode, readOnly })
  useEffect(() => {
    latest.current = { onChange, onMount, options, vscodeMode, readOnly }
  })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const uri = monaco.Uri.parse(`inmemory://devdeck/${encodeURI(key)}`)
    const model = models.acquire(key, value, resolvedLanguage, uri)

    const instance = monaco.editor.create(host, {
      ...buildEditorOptions(latest.current.vscodeMode, latest.current.options),
      readOnly: latest.current.readOnly,
      model: model as editor.ITextModel,
    })
    editorRef.current = instance
    setMounted(true)

    const changeSub = instance.onDidChangeModelContent(() => {
      latest.current.onChange?.(instance.getValue())
    })
    const cleanupMount = latest.current.onMount?.(instance)

    return () => {
      if (typeof cleanupMount === 'function') cleanupMount()
      changeSub.dispose()
      editorRef.current = null
      setMounted(false)
      // Dispose the instance but NOT the model — release() decides that.
      instance.dispose()
      models.release(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolvedLanguage])

  // Controlled-value sync. Guarded on inequality so echoing our own onChange
  // back in does not reset the cursor on every keystroke.
  useEffect(() => {
    const instance = editorRef.current
    if (!instance) return
    if (instance.getValue() !== value) instance.setValue(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({
      ...buildEditorOptions(vscodeMode, options),
      readOnly,
    })
  }, [vscodeMode, options, readOnly])

  // Deps are [reveal, ready, mounted], NOT [reveal, value]. `ready` flips
  // false->true exactly once, when the file's real content finishes loading, and
  // never changes again for the life of this tab, whereas `value` changes on
  // every keystroke. Depending on `value` re-runs this effect after every edit —
  // re-selecting reveal's range and re-focusing — because `reveal` is never
  // cleared once a search or definition jump has fired. That snapped the cursor
  // back to the searched location on every keystroke, making it look like only
  // that location could be edited.
  useEffect(() => {
    const instance = editorRef.current
    if (!instance || !reveal || !ready) return
    const model = instance.getModel()
    if (!model) return
    const range = toMonacoRange(reveal, model.getLineCount(), (line) =>
      model.getLineMaxColumn(line),
    )
    instance.setSelection(range)
    instance.revealRangeInCenter(range)
    instance.focus()
  }, [reveal, ready, mounted])

  return (
    <div className={cn('flex h-full min-h-0 flex-1 flex-col overflow-hidden', className)}>
      {vscodeMode ? <Breadcrumbs path={path} /> : null}
      <div
        ref={hostRef}
        aria-label={ariaLabel ?? `Edit ${path}`}
        className="min-h-0 flex-1"
      />
    </div>
  )
}

/** Breadcrumbs are workbench UI, not a standalone-editor feature, so DevDeck
 *  renders its own. Display-only by design — clicking a segment is out of scope. */
function Breadcrumbs({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return null
  return (
    <div className="flex flex-none items-center gap-1 overflow-hidden border-b border-devdeck-border bg-devdeck-surface-2 px-3 py-1 font-mono text-[10.5px] text-devdeck-dim">
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="text-devdeck-muted-2">›</span> : null}
          <span className={cn('truncate', index === segments.length - 1 && 'text-devdeck-muted')}>
            {segment}
          </span>
        </span>
      ))}
    </div>
  )
}
