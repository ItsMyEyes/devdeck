import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Machine } from '@/store/types'
import type { editor } from 'monaco-editor/editor'
import { monaco } from '@/features/editor/monacoSetup'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { EditorReveal } from '@/features/editor/reveal'
import {
  acquireLspSession,
  languageIdForPath,
  type LspSession,
  type LspStatus,
} from './lsp/lspSession'
import type { LspRange } from './lsp/lspWorkspaceEdit'
import {
  applyRenamePlan,
  buildRenamePlan,
  prepareRename,
  type RenamePlan,
  type RenameSubject,
} from './lsp/lspRename'
import { createEditorOpener } from './lsp/editorOpener'
import { crossFileTargets, normalizeDefinitionResult } from './lsp/lspDefinition'
import { languageForPath } from '@/features/editor/languageForPath'
import {
  findDefinition,
  findImportedSource,
  offsetToLineColumn,
  quotedPathAt,
  resolveImportFile,
} from './lsp/definitionFallback'
import { RenameSymbolDialog } from './RenameSymbolDialog'

export interface DefinitionTarget {
  symbol?: string
  range?: LspRange
}

export interface DefinitionReveal extends DefinitionTarget {
  requestId: number
}

/** Same-file jump for the regex/import heuristics: selects and scrolls to the
 *  symbol's range directly on the Monaco instance. Kept local (rather than in
 *  `definitionFallback.ts`) because it mutates editor state — that module
 *  stays pure so it's unit-testable without a browser. */
function revealSymbolRange(
  instance: editor.ICodeEditor,
  source: string,
  symbol: string,
) {
  const definition = findDefinition(source, symbol)
  if (!definition) return false
  const start = offsetToLineColumn(source, definition.from)
  const end = offsetToLineColumn(source, definition.to)
  const range = {
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.line,
    endColumn: end.column,
  }
  instance.setSelection(range)
  instance.revealRangeInCenter(range)
  instance.focus()
  return true
}

export function CodeFileEditor({
  worktreeId,
  machine,
  path,
  value,
  ready,
  onChange,
  onOpenDefinition,
  isPathDirty,
  reveal,
}: {
  worktreeId: string
  machine: Machine
  path: string
  value: string
  /** True once `value` is the file's real, loaded content (vs. the empty
   *  placeholder the caller renders while its fetch is in flight) — see the
   *  reveal effect below for why this must gate on load-completion rather
   *  than on `value` itself. */
  ready: boolean
  onChange: (value: string) => void
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  /** Reports whether an open tab for `path` has unsaved changes. A cross-file
   *  rename refuses rather than overwrite one. */
  isPathDirty: (path: string) => boolean
  reveal?: DefinitionReveal
}) {
  const languageId = languageIdForPath(path)
  const [session, setSession] = useState<LspSession | null>(null)

  const fallbackDefinition = useCallback(
    (instance: editor.ICodeEditor, position: { lineNumber: number; column: number }) => {
      const model = instance.getModel()
      if (!model) return
      const source = model.getValue()
      const offset = model.getOffsetAt(position)
      const quotedPath = quotedPathAt(source, offset)
      const word = model.getWordAtPosition(position)
      const symbol = word?.word ?? ''
      const namespace = word
        ? model
            .getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: Math.max(1, word.startColumn - 80),
              endLineNumber: position.lineNumber,
              endColumn: word.startColumn,
            })
            .match(/([A-Za-z_$][\w$]*)\.\s*$/)?.[1]
        : undefined
      const imported = findImportedSource(source, namespace ?? symbol)

      if (!quotedPath && !imported && symbol && revealSymbolRange(instance, source, symbol)) return

      const targetSource = quotedPath ?? imported?.source
      if (!targetSource) {
        if (symbol) toast.error(`Definition for ${symbol} was not found`)
        return
      }

      void resolveImportFile(machine, worktreeId, path, targetSource)
        .then((targetPath) => {
          if (!targetPath) {
            toast.error(`Local file ${targetSource} was not found`)
            return
          }
          onOpenDefinition(targetPath, { symbol: imported?.revealSymbol ?? symbol })
        })
        .catch(() => toast.error(`Could not resolve ${targetSource}`))
    },
    [machine, onOpenDefinition, path, worktreeId],
  )

  const queryClient = useQueryClient()
  const renameModelRef = useRef<editor.ITextModel | null>(null)
  const [renameSubject, setRenameSubject] = useState<RenameSubject | null>(null)
  const [renamePlan, setRenamePlan] = useState<RenamePlan | null>(null)
  const [renamePending, setRenamePending] = useState(false)

  const closeRename = useCallback(() => {
    setRenameSubject(null)
    setRenamePlan(null)
    setRenamePending(false)
    renameModelRef.current = null
  }, [])

  const startRename = useCallback(
    async (instance: editor.ICodeEditor, position: { lineNumber: number; column: number }) => {
      if (!session) return
      const model = instance.getModel()
      if (!model) return
      const subject = await prepareRename(session, path, model, position)
      if (!subject) {
        toast.error('There is nothing to rename here')
        return
      }
      renameModelRef.current = model
      setRenamePlan(null)
      setRenameSubject(subject)
    },
    [session, path],
  )

  const submitRenameName = useCallback(
    (newName: string) => {
      if (!session || !renameSubject) return
      setRenamePending(true)
      void buildRenamePlan({ session, path, subject: renameSubject, newName, isPathDirty })
        .then((result) => {
          if (!result.ok) {
            toast.error(result.reason)
            closeRename()
            return
          }
          setRenamePlan(result.plan)
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Rename failed')
          closeRename()
        })
        .finally(() => setRenamePending(false))
    },
    [session, path, renameSubject, isPathDirty, closeRename],
  )

  const confirmRename = useCallback(() => {
    const model = renameModelRef.current
    if (!model || !renamePlan) return
    setRenamePending(true)
    void applyRenamePlan({ model, plan: renamePlan, machine, worktreeId, queryClient })
      .then(() => {
        const total = renamePlan.otherFiles.length + (renamePlan.currentEdits.length > 0 ? 1 : 0)
        toast.success(`Renamed across ${total} file${total === 1 ? '' : 's'}`)
        closeRename()
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Rename failed')
        setRenamePending(false)
      })
  }, [renamePlan, machine, worktreeId, queryClient, closeRename])

  // `onOpenDefinition`, `fallbackDefinition` and `startRename` all change
  // identity on unrelated pane churn — `ExpandedTerminal`'s `openDefinition`
  // closes over `layout`, which zustand replaces on any tab open/close, split
  // or focus change, and every mounted tab re-renders when it does.
  // `handleMount` below runs exactly once per model (its deps are `[]`), so
  // its long-lived `addAction` callbacks must reach the latest handlers
  // through this ref rather than closing over the props directly.
  const handlersRef = useRef({
    onOpenDefinition,
    fallbackDefinition,
    startRename,
    hasSession: session !== null,
  })
  useEffect(() => {
    handlersRef.current = { onOpenDefinition, fallbackDefinition, startRename, hasSession: session !== null }
  })

  // The session effect keys on `[languageId, worktreeId, machine]`, not on
  // `path` — a session is shared by every file of that language in the
  // worktree. The definition provider it registers still needs the current
  // path to pick a Monaco language id, so it reads it through this ref.
  const pathRef = useRef(path)
  useEffect(() => {
    pathRef.current = path
  })

  useEffect(() => {
    setSession(null)
    if (!languageId) return
    let cancelled = false
    let releaseFn: (() => void) | null = null
    let openerDisposable: { dispose(): void } | null = null
    let definitionDisposable: { dispose(): void } | null = null
    void acquireLspSession(machine, worktreeId, languageId)
      .then((acquired) => {
        if (cancelled) {
          acquired.release()
          return
        }
        releaseFn = acquired.release
        setSession(acquired.session)

        // Cross-file go-to-definition: monaco calls this when a definition
        // (or a link) resolves to a uri other than the current model's.
        const opener = createEditorOpener({
          pathFromUri: acquired.session.pathFromUri,
          openPath: (targetPath, targetReveal) =>
            handlersRef.current.onOpenDefinition(targetPath, {
              range: targetReveal
                ? {
                    start: { line: targetReveal.startLine - 1, character: targetReveal.startColumn - 1 },
                    end: { line: targetReveal.endLine - 1, character: targetReveal.endColumn - 1 },
                  }
                : undefined,
            }),
        })
        openerDisposable = monaco.editor.registerEditorOpener({
          openCodeEditor: (_source, resource, selectionOrPosition) =>
            opener(resource.toString(), selectionOrPosition as never),
        })

        // DevDeck's own definition provider, registered alongside the one
        // MonacoLspClient installs. The built-in provider cannot answer a
        // cross-file definition: it maps every result through
        // TextDocumentSynchronizer.translateBackRange, which throws when the
        // target file has no loaded Monaco model, so the whole provider rejects
        // and Monaco reports "No definition found" even though the server
        // answered. See lspDefinition.ts. This one builds locations straight
        // from the LSP response, and Monaco hands the foreign uri to the
        // editor opener registered above.
        definitionDisposable = monaco.languages.registerDefinitionProvider(
          languageForPath(pathRef.current),
          {
            provideDefinition: async (model, position) => {
              const raw = await acquired.session.transport
                .request('textDocument/definition', {
                  textDocument: { uri: model.uri.toString() },
                  position: { line: position.lineNumber - 1, character: position.column - 1 },
                })
                .catch(() => null)

              return crossFileTargets(
                normalizeDefinitionResult(raw),
                model.uri.toString(),
              ).map((target) => ({
                uri: monaco.Uri.parse(target.uri),
                range: {
                  startLineNumber: target.range.start.line + 1,
                  startColumn: target.range.start.character + 1,
                  endLineNumber: target.range.end.line + 1,
                  endColumn: target.range.end.character + 1,
                },
              }))
            },
          },
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      releaseFn?.()
      openerDisposable?.dispose()
      definitionDisposable?.dispose()
    }
  }, [languageId, worktreeId, machine])

  useEffect(() => {
    if (!session || !languageId) return
    const toastId = `lsp-status-${worktreeId}-${languageId}`
    let sawInstalling = false
    const handleStatus = (status: LspStatus, message?: string) => {
      if (status === 'installing') {
        sawInstalling = true
        toast.loading(message ?? `Installing ${languageId} language server…`, { id: toastId })
      } else if (status === 'ready' && sawInstalling) {
        toast.success('Language server ready', { id: toastId })
      } else if (status === 'error') {
        toast.error(message ?? 'Language server unavailable', { id: toastId })
      }
    }
    handleStatus(session.getStatus(), session.getStatusMessage())
    return session.subscribeStatus(handleStatus)
  }, [session, languageId, worktreeId])

  const handleMount = useCallback((instance: editor.IStandaloneCodeEditor) => {
    const disposables: Array<{ dispose(): void }> = []

    // F2 overrides monaco's built-in `editor.action.rename`. The built-in
    // applies its WorkspaceEdit only to models that are already loaded, so a
    // rename would silently skip every file that is not open — see
    // lspWorkspaceEdit.ts. DevDeck's dialog shows the full blast radius and
    // writes the other files through the machine API instead.
    disposables.push(
      instance.addAction({
        id: 'devdeck.rename',
        label: 'Rename Symbol (DevDeck)',
        keybindings: [monaco.KeyCode.F2],
        run: (ed) => {
          const position = ed.getPosition()
          if (position) void handlersRef.current.startRename(ed, position)
        },
      }),
    )

    // Ctrl/Cmd-click and F12 reach the LSP definition provider that
    // MonacoLspClient registered. When there is no session there is no
    // provider, so the regex/import heuristics are the whole feature. The
    // action is always registered and checks for a session at call time —
    // `handleMount` must not depend on `session`, or every session transition
    // would remount the editor and lose undo history.
    disposables.push(
      instance.addAction({
        id: 'devdeck.fallbackDefinition',
        label: 'Go to Definition (heuristic)',
        keybindings: [monaco.KeyCode.F12],
        run: (ed) => {
          if (handlersRef.current.hasSession) return
          const position = ed.getPosition()
          if (position) handlersRef.current.fallbackDefinition(ed, position)
        },
      }),
    )

    return () => {
      for (const disposable of disposables) disposable.dispose()
    }
  }, [])

  // Deps are `[reveal, ready]`, NOT `[reveal, value]` — see the identical
  // reasoning on `MonacoEditor`'s own reveal effect. `reveal` is DevDeck's
  // LSP-shaped `DefinitionReveal` (0-based `line`/`character`, optionally a
  // bare `symbol`); this derives the 1-based `EditorReveal` `MonacoEditor`
  // understands, resolving a symbol-only reveal against the source text with
  // the same heuristic `fallbackDefinition` uses for a same-file jump.
  const monacoReveal = useMemo<EditorReveal | undefined>(() => {
    if (!reveal || !ready) return undefined
    if (reveal.range) {
      const { start, end } = reveal.range
      return {
        startLine: start.line + 1,
        startColumn: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
      }
    }
    if (reveal.symbol) {
      const definition = findDefinition(value, reveal.symbol)
      if (definition) {
        const start = offsetToLineColumn(value, definition.from)
        const end = offsetToLineColumn(value, definition.to)
        return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column }
      }
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, ready])

  return (
    <>
      <MonacoEditor
        path={path}
        modelKey={`${machine.id}:${worktreeId}:${path}`}
        // Once the LSP session resolves, its `documentUri` is the exact
        // `file://` address the server was told about (and that `lspRename.ts`
        // addresses directly). Handing the same string to `MonacoEditor` keeps
        // the visible model's own uri in sync with it — see MonacoEditor's
        // `uri` prop doc for why a mismatch here silently breaks completion,
        // hover, go-to-definition and rename for this file.
        uri={session?.documentUri(path)}
        value={value}
        ready={ready}
        reveal={monacoReveal}
        onChange={onChange}
        onMount={handleMount}
        ariaLabel={`Edit ${path}`}
        className="h-full min-h-0 flex-1"
      />
      <RenameSymbolDialog
        open={renameSubject !== null}
        symbol={renameSubject?.symbol ?? ''}
        plan={renamePlan}
        pending={renamePending}
        currentPath={path}
        onCancel={closeRename}
        onSubmitName={submitRenameName}
        onConfirmPlan={confirmRename}
      />
    </>
  )
}
