import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { autocompletion, completeAnyWord } from '@codemirror/autocomplete'
import {
  LanguageDescription,
  syntaxTree,
  type LanguageSupport,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { redo, undo } from '@codemirror/commands'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror, {
  EditorView,
  keymap,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { searchWorktreeFiles } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import {
  acquireLspSession,
  languageIdForPath,
  type LspSession,
  type LspStatus,
} from './lspSession'
import {
  lspExtensions,
  revealRange,
  type DefinitionReveal,
  type DefinitionTarget,
} from './lspExtensions'
import { applyRenamePlan, buildRenamePlan, prepareRename, type RenamePlan, type RenameSubject } from './lspRename'
import { RenameSymbolDialog } from './RenameSymbolDialog'

export type { DefinitionReveal, DefinitionTarget }

interface DefinitionRange {
  from: number
  to: number
}

const candidateExtensions = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'go',
  'py',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'vue',
  'svelte',
  'yaml',
  'yml',
  'toml',
  'sql',
]

export const devdeckCodeTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#090a0c',
      color: '#d8d8d4',
      fontSize: '12.5px',
    },
    '.cm-scroller': {
      fontFamily:
        '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      lineHeight: '1.65',
      overflow: 'auto',
    },
    '.cm-content': {
      minHeight: '100%',
      order: '2',
      padding: '10px 0',
      caretColor: '#62d8e8',
    },
    '.cm-line': {
      padding: '0 16px',
    },
    '.cm-gutters': {
      position: 'sticky',
      right: 'auto',
      left: '0',
      zIndex: '2',
      order: '1',
      border: 'none',
      borderRight: '1px solid #22252a',
      backgroundColor: '#07080a',
      color: '#626771',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '44px',
      padding: '0 12px 0 10px',
      textAlign: 'right',
    },
    '.cm-foldGutter': {
      display: 'none',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.025)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(98, 216, 232, 0.08)',
      color: '#9fe6ef',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#62d8e8',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      {
        backgroundColor: 'rgba(47, 143, 157, 0.34)',
      },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(226, 183, 80, 0.22)',
      outline: '1px solid rgba(226, 183, 80, 0.45)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(98, 216, 232, 0.25)',
    },
    '.cm-panels': {
      borderColor: '#292b30',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
    '.cm-textfield': {
      border: '1px solid #363940',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
    '.cm-button': {
      border: '1px solid #363940',
      backgroundImage: 'none',
      backgroundColor: '#1d1f23',
      color: '#d8d8d4',
    },
    '.cm-tooltip': {
      border: '1px solid #292b30',
      backgroundColor: '#0d0e10',
      color: '#d8d8d4',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'rgba(98, 216, 232, 0.12)',
      color: '#eeeeeb',
    },
    '.cm-diagnostic': {
      borderLeftColor: '#d78c45',
      backgroundColor: '#111214',
      color: '#d8d8d4',
    },
    '.cm-diagnostic-error': {
      borderLeftColor: '#e36d6d',
    },
    '.cm-lsp-highlight-text': {
      backgroundColor: 'rgba(216, 216, 212, 0.10)',
    },
    '.cm-lsp-highlight-read': {
      backgroundColor: 'rgba(98, 216, 232, 0.14)',
    },
    '.cm-lsp-highlight-write': {
      backgroundColor: 'rgba(226, 183, 80, 0.18)',
    },
    '.cm-lsp-rename-panel': {
      padding: '4px 8px',
      borderBottom: '1px solid #292b30',
      backgroundColor: '#0d0e10',
    },
    '.cm-lintRange-error': {
      backgroundImage:
        'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%276%27 height=%273%27%3E%3Cpath d=%27M0 2.5L1.5 1l1.5 1.5L4.5 1 6 2.5%27 fill=%27none%27 stroke=%27%23e36d6d%27 stroke-width=%271%27/%3E%3C/svg%3E")',
    },
  },
  { dark: true },
)

export const syntaxDiagnostics = linter(
  (view) => {
    const diagnostics: Diagnostic[] = []
    const documentLength = view.state.doc.length

    syntaxTree(view.state).iterate({
      enter(node) {
        if (!node.type.isError || diagnostics.length >= 100) return
        diagnostics.push({
          from: node.from,
          to: Math.min(documentLength, Math.max(node.from + 1, node.to)),
          severity: 'error',
          message: 'Syntax error',
        })
      },
    })

    return diagnostics
  },
  { delay: 350 },
)

// CodeMirror's default history keymap binds undo/redo to Cmd on macOS
// (Mod-z) and rebinds redo to Cmd-Shift-Z there, leaving no Mac binding for
// the literal Ctrl+Z / Ctrl+Y combo users expect from other editors.
export const explicitHistoryKeymap = Prec.highest(
  keymap.of([
    { key: 'Ctrl-z', run: undo, preventDefault: true },
    { key: 'Ctrl-y', run: redo, preventDefault: true },
    { key: 'Ctrl-Shift-z', run: redo, preventDefault: true },
  ]),
)

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function identifierRegex(symbol: string) {
  return new RegExp(`\\b${escapeRegex(symbol)}\\b`)
}

function normalizeWorkspacePath(value: string) {
  const normalized: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (normalized.length === 0) return null
      normalized.pop()
    } else {
      normalized.push(part)
    }
  }
  return normalized.join('/')
}

function resolveImportBase(currentPath: string, source: string) {
  const cleanSource = source.replace(/[?#].*$/, '')
  if (cleanSource.startsWith('@/'))
    return normalizeWorkspacePath(`src/${cleanSource.slice(2)}`)
  if (cleanSource.startsWith('/'))
    return normalizeWorkspacePath(cleanSource.slice(1))
  if (!cleanSource.startsWith('.')) return null
  const currentFolder = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : ''
  return normalizeWorkspacePath(`${currentFolder}/${cleanSource}`)
}

async function resolveImportFile(
  machine: Machine,
  worktreeId: string,
  currentPath: string,
  source: string,
) {
  const base = resolveImportBase(currentPath, source)
  if (!base) return null

  const lastSegment = base.split('/').pop() ?? base
  const hasExtension = /\.[A-Za-z0-9]+$/.test(lastSegment)
  const candidates = hasExtension
    ? [base]
    : [
        base,
        ...candidateExtensions.map((extension) => `${base}.${extension}`),
        ...candidateExtensions.map((extension) => `${base}/index.${extension}`),
      ]
  const pattern = `^(?:${candidates.map(escapeRegex).join('|')})$`
  const matches = await searchWorktreeFiles(machine, worktreeId, pattern)
  return (
    candidates.find((candidate) => matches.includes(candidate)) ??
    matches[0] ??
    null
  )
}

function findDefinition(
  source: string,
  symbol: string,
): DefinitionRange | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return null
  const escaped = escapeRegex(symbol)
  const patterns = [
    new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\bfunc\\s+(?:\\([^\\n)]*\\)\\s*)?${escaped}\\b`),
    new RegExp(`\\bdef\\s+${escaped}\\b`),
    new RegExp(`\\bfn\\s+${escaped}\\b`),
    new RegExp(
      `\\b(?:class|interface|type|enum|struct|trait)\\s+${escaped}\\b`,
    ),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(
      `(?:^|\\n)\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+)*${escaped}\\s*\\(`,
    ),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const symbolOffset = match[0].lastIndexOf(symbol)
    const from = match.index + Math.max(0, symbolOffset)
    return { from, to: from + symbol.length }
  }
  return null
}

function quotedPathAt(source: string, position: number) {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const lineEndMatch = source.indexOf('\n', position)
  const lineEnd = lineEndMatch < 0 ? source.length : lineEndMatch
  const line = source.slice(lineStart, lineEnd)
  const strings = /(['"`])([^'"`\n]+)\1/g

  for (const match of line.matchAll(strings)) {
    const start = lineStart + (match.index ?? 0)
    const end = start + match[0].length
    if (position > start && position < end) return match[2]
  }
  return null
}

function findImportedSource(source: string, symbol: string) {
  const symbolPattern = identifierRegex(symbol)
  const importPatterns = [
    /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /export\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /(?:const|let|var)\s+([^=\n]+)=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (!symbolPattern.test(match[1])) continue
      const alias = new RegExp(
        `\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${escapeRegex(symbol)}\\b`,
      ).exec(match[1])
      return { source: match[2], revealSymbol: alias?.[1] ?? symbol }
    }
  }
  return null
}

function revealDefinition(view: EditorView, source: string, symbol: string) {
  const definition = findDefinition(source, symbol)
  if (!definition) return false
  view.dispatch({
    selection: { anchor: definition.from, head: definition.to },
    scrollIntoView: true,
  })
  view.focus()
  return true
}

export function useFileLanguage(path: string) {
  const [language, setLanguage] = useState<LanguageSupport | null>(null)

  useEffect(() => {
    let cancelled = false
    setLanguage(null)

    const description = LanguageDescription.matchFilename(languages, path)
    if (!description) return

    void description
      .load()
      .then((support) => {
        if (!cancelled) setLanguage(support)
      })
      .catch(() => {
        if (!cancelled) setLanguage(null)
      })

    return () => {
      cancelled = true
    }
  }, [path])

  return language
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
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const language = useFileLanguage(path)
  const languageId = languageIdForPath(path)
  // `@uiw/react-codemirror` creates its EditorView across two render passes
  // (mount → measure its container → create the view), so on a freshly
  // mounted tab `editorRef.current?.view` can still be undefined by the time
  // the reveal effect below runs, even once `reveal`/`ready` are already
  // set — there's no later `ready` change to give it a second chance.
  // `onCreateEditor` fires exactly once the view actually exists; bumping
  // `viewReady` re-runs the reveal effect at that point instead of relying
  // on incidental extra renders.
  const [viewReady, setViewReady] = useState(false)

  const [session, setSession] = useState<LspSession | null>(null)

  useEffect(() => {
    setSession(null)
    if (!languageId) return
    let cancelled = false
    let releaseFn: (() => void) | null = null
    void acquireLspSession(machine, worktreeId, languageId)
      .then((acquired) => {
        if (cancelled) {
          acquired.release()
          return
        }
        releaseFn = acquired.release
        setSession(acquired.session)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      releaseFn?.()
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

  const fallbackDefinition = useCallback(
    (view: EditorView, position: number) => {
      const source = view.state.doc.toString()
      const quotedPath = quotedPathAt(source, position)
      const word = view.state.wordAt(position)
      const symbol = word ? source.slice(word.from, word.to) : ''
      const namespace = word
        ? source.slice(Math.max(0, word.from - 80), word.from).match(/([A-Za-z_$][\w$]*)\.\s*$/)?.[1]
        : undefined
      const imported = findImportedSource(source, namespace ?? symbol)

      if (!quotedPath && !imported && symbol && revealDefinition(view, source, symbol)) return

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
  const renameViewRef = useRef<EditorView | null>(null)
  const [renameSubject, setRenameSubject] = useState<RenameSubject | null>(null)
  const [renamePlan, setRenamePlan] = useState<RenamePlan | null>(null)
  const [renamePending, setRenamePending] = useState(false)

  const closeRename = useCallback(() => {
    setRenameSubject(null)
    setRenamePlan(null)
    setRenamePending(false)
    renameViewRef.current = null
  }, [])

  const startRename = useCallback(
    async (view: EditorView, pos: number) => {
      if (!session) return
      const subject = await prepareRename(view, session, path, pos)
      if (!subject) {
        toast.error('There is nothing to rename here')
        return
      }
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
    const view = renameViewRef.current
    if (!view || !renamePlan) return
    setRenamePending(true)
    void applyRenamePlan({ view, plan: renamePlan, machine, worktreeId, queryClient })
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

  const languageExtensions = useMemo(() => {
    if (!session) {
      return [
        autocompletion({ override: [completeAnyWord] }),
        syntaxDiagnostics,
        // Without a language server the only definitions available are the
        // regex/import heuristics, so this handler is the whole feature.
        EditorView.domEventHandlers({
          mousedown(event, view) {
            if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (position === null) return false
            event.preventDefault()
            view.focus()
            fallbackDefinition(view, position)
            return true
          },
        }),
      ]
    }
    return lspExtensions({
      session,
      path,
      onOpenDefinition,
      onFallbackDefinition: fallbackDefinition,
      onRequestRename: (view, pos) => {
        renameViewRef.current = view
        void startRename(view, pos)
      },
    })
  }, [session, path, onOpenDefinition, fallbackDefinition, startRename])

  // Deps are `[reveal, ready]`, NOT `[reveal, value]`: `ready` flips
  // false→true exactly once (when the file's real content finishes
  // loading) and then never changes again for the life of this tab, whereas
  // `value` changes on every keystroke once the file is open. Depending on
  // `value` here would re-run this effect — re-selecting `reveal`'s range
  // and re-focusing — after every single edit, since `reveal` itself is
  // never cleared once a search/definition jump has fired (it's only
  // removed when the tab closes). That snapped the cursor/selection back to
  // the original searched location on every keystroke, making it look like
  // only that location could be edited. Gating on `ready` instead still
  // retries the reveal once real content has loaded (fixing the case where
  // it first fired against the still-empty placeholder) without re-firing
  // on later edits. Reads `view.state.doc.toString()` rather than the
  // `value` prop for the same reason — `value` isn't a dependency anymore,
  // so it may be stale by the time this runs.
  useEffect(() => {
    const view = editorRef.current?.view
    if (!view || !reveal || !ready) return
    if (reveal.range) {
      revealRange(view, reveal.range)
    } else if (reveal.symbol) {
      revealDefinition(view, view.state.doc.toString(), reveal.symbol)
    }
  }, [reveal, ready, viewReady])

  return (
    <>
      <CodeMirror
        ref={editorRef}
        value={value}
        height="100%"
        width="100%"
        aria-label={`Edit ${path}`}
        title="Ctrl/Cmd-click a symbol or import to go to its definition · F2 to rename · Shift-Alt-F to format"
        theme="dark"
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          lintKeymap: true,
          tabSize: 2,
        }}
        extensions={[
          oneDark,
          devdeckCodeTheme,
          explicitHistoryKeymap,
          lintGutter(),
          ...languageExtensions,
          ...(language ? [language] : []),
        ]}
        onChange={onChange}
        onCreateEditor={() => setViewReady(true)}
        className="h-full min-h-0 flex-1 overflow-hidden"
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
