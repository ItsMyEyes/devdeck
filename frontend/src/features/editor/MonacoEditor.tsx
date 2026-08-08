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
  /** The model's real `monaco.Uri` string (e.g. `file:///root/src/main.go`).
   *  Omitted by every non-LSP surface, which gets a synthetic `inmemory://`
   *  identity below. `CodeFileEditor` passes its LSP session's
   *  `documentUri(path)` here once the session resolves — `MonacoLspClient`'s
   *  `TextDocumentSynchronizer` (see `lsp/lspSession.ts`) auto-opens every
   *  model it can see under whatever URI that model already has, and
   *  DevDeck's own rename/definition requests address documents by this same
   *  `documentUri`, so the two must match or the server ends up tracking a
   *  document under a URI nobody ever asks it about. `documentUri` is only
   *  known after an async round trip to the backend (it needs the worktree's
   *  real, symlink-resolved filesystem root), so this prop legitimately
   *  starts undefined and flips to a real value after mount — see the effect
   *  below for how that identity change is handled without losing the
   *  buffer's live content. */
  uri?: string
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
  uri,
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
  // `uri` starts undefined and, for LSP-backed callers, later resolves to a
  // real `file://` address (see the `uri` prop doc above). Folding it into the
  // registry key below means that transition is handled by the exact same
  // acquire/create-then-release/dispose machinery as an ordinary key change
  // (e.g. switching files) — no separate "rebase this model onto a new uri"
  // code path to get wrong. The cost is a one-time editor-instance recreation
  // (undo history resets) the moment the LSP session resolves, which is far
  // cheaper than the alternative of never correcting the model's identity.
  const registryKey = uri ? `${key}::${uri}` : key

  // Latest-value refs: the mount effect must run exactly once per key, so it
  // cannot close over props that change on every keystroke.
  const latest = useRef({ onChange, onMount, options, vscodeMode, readOnly })
  useEffect(() => {
    latest.current = { onChange, onMount, options, vscodeMode, readOnly }
  })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const modelUri = monaco.Uri.parse(uri ?? `inmemory://devdeck/${encodeURI(key)}`)
    const model = models.acquire(registryKey, value, resolvedLanguage, modelUri)

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
      // React runs every unmounted subtree's layout-effect *cleanup* before
      // any newly-mounted subtree's layout-effect *setup*, for the whole tree,
      // within a single commit (commitMutationEffects fully precedes
      // commitLayoutEffects) — see modelRegistry.ts's doc comment for why that
      // matters. A drag-to-split/merge re-parents this editor's content into a
      // different `LeafPaneView` in one `PaneCanvas` update (`moveTab` always
      // allocates a fresh leaf id), which is therefore always an unmount of
      // this instance and a mount of a new one *in the same commit* — not the
      // "remount acquires before unmount releases" order modelRegistry.test.ts
      // assumes. (React's Strict Mode double-invoke hits the exact same
      // ordering on every ordinary mount in dev, which is how this surfaces
      // immediately rather than only on a drag.) Deferring the release past
      // this synchronous commit — but still well before the next paint, since
      // microtasks run before the browser can paint — lets a same-commit
      // re-acquire land first and keep the model (and its undo history, and
      // the LSP's didOpen/didChange version counter) alive across the move.
      queueMicrotask(() => models.release(registryKey))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryKey, resolvedLanguage])

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

  // Deps are [reveal, ready, mounted, registryKey], NOT [reveal, value].
  // `ready` flips false->true exactly once, when the file's real content
  // finishes loading, and never changes again for the life of this tab, whereas
  // `value` changes on every keystroke. Depending on `value` re-runs this effect
  // after every edit — re-selecting reveal's range and re-focusing — because
  // `reveal` is never cleared once a search or definition jump has fired. That
  // snapped the cursor back to the searched location on every keystroke, making
  // it look like only that location could be edited.
  //
  // `registryKey` is here because it is the *only* signal that the instance
  // below was rebuilt on a fresh model scrolled back to line 1. `mounted` cannot
  // stand in for it: the layout effect above calls setMounted(false) in its
  // cleanup and setMounted(true) in its setup within one commit, so React
  // collapses the pair to no change at all and this effect would never re-run.
  // That is exactly what happens on every content-search jump into a code file —
  // the reveal lands, then the LSP session resolves `uri` a moment later, the
  // key changes, and the rebuilt editor sat at the top of the file with the
  // jump silently discarded.
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
  }, [reveal, ready, mounted, registryKey])

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
    <div className="flex flex-none items-center gap-1 overflow-hidden border-b border-devdeck-border bg-devdeck-card-wash px-3 py-1 font-mono text-[10.5px] text-devdeck-fg-2">
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="text-devdeck-fg-2">›</span> : null}
          <span className={cn('truncate', index === segments.length - 1 && 'text-devdeck-fg-2')}>
            {segment}
          </span>
        </span>
      ))}
    </div>
  )
}
