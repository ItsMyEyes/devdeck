import { useEffect, useMemo, useRef, useState } from 'react'
import {
  autocompletion,
  completeAnyWord,
  type CompletionSource,
} from '@codemirror/autocomplete'
import {
  LanguageDescription,
  syntaxTree,
  type LanguageSupport,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { redo, undo } from '@codemirror/commands'
import {
  forceLinting,
  linter,
  lintGutter,
  type Diagnostic,
} from '@codemirror/lint'
import { Prec, type Text } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror, {
  EditorView,
  keymap,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror'
import { toast } from 'sonner'
import { searchWorktreeFiles } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import {
  acquireLspClient,
  languageIdForPath,
  type LspClient,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspPosition,
  type LspRange,
} from './lspClient'

export interface DefinitionReveal {
  symbol?: string
  range?: LspRange
  requestId: number
}

export type DefinitionTarget = Omit<DefinitionReveal, 'requestId'>

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

export const loomCodeTheme = EditorView.theme(
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

function offsetToPosition(document: Text, offset: number): LspPosition {
  const line = document.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

function positionToOffset(document: Text, position: LspPosition) {
  const lineNumber = Math.min(document.lines, Math.max(1, position.line + 1))
  const line = document.line(lineNumber)
  return Math.min(line.to, line.from + Math.max(0, position.character))
}

function revealRange(view: EditorView, range: LspRange) {
  const anchor = positionToOffset(view.state.doc, range.start)
  const head = positionToOffset(view.state.doc, range.end)
  view.dispatch({
    selection: { anchor, head },
    scrollIntoView: true,
  })
  view.focus()
}

function completionType(kind?: number) {
  const types: Record<number, string> = {
    2: 'method',
    3: 'function',
    4: 'function',
    5: 'variable',
    6: 'variable',
    7: 'class',
    8: 'interface',
    9: 'module',
    10: 'property',
    12: 'constant',
    13: 'constant',
    14: 'keyword',
    18: 'text',
    20: 'variable',
    21: 'constant',
    22: 'type',
    23: 'type',
  }
  return kind ? types[kind] : undefined
}

function completionDocumentation(item: LspCompletionItem) {
  if (typeof item.documentation === 'string') return item.documentation
  return item.documentation?.value
}

function plainCompletionText(item: LspCompletionItem) {
  const value = item.textEdit?.newText ?? item.insertText ?? item.label
  if (item.insertTextFormat !== 2) return value
  return value
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '')
}

function lspCompletionSource(
  client: LspClient,
  path: string,
): CompletionSource {
  return async (context) => {
    const word = context.matchBefore(/[A-Za-z_$][\w$]*$/)
    if (!context.explicit && (!word || word.from === word.to)) return null

    try {
      const items = await client.completion(
        path,
        offsetToPosition(context.state.doc, context.pos),
      )
      return {
        from: word?.from ?? context.pos,
        options: items.map((item) => ({
          label: item.label,
          apply: plainCompletionText(item),
          type: completionType(item.kind),
          detail: item.detail,
          info: completionDocumentation(item),
        })),
        validFor: /^[\w$]*$/,
      }
    } catch {
      return null
    }
  }
}

function diagnosticSeverity(severity?: number): Diagnostic['severity'] {
  if (severity === 1) return 'error'
  if (severity === 2) return 'warning'
  if (severity === 4) return 'hint'
  return 'info'
}

function codeMirrorDiagnostics(document: Text, diagnostics: LspDiagnostic[]) {
  return diagnostics.map(
    (diagnostic): Diagnostic => ({
      from: positionToOffset(document, diagnostic.range.start),
      to: Math.max(
        positionToOffset(document, diagnostic.range.start),
        positionToOffset(document, diagnostic.range.end),
      ),
      severity: diagnosticSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source,
    }),
  )
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
  onChange,
  onOpenDefinition,
  reveal,
}: {
  worktreeId: string
  machine: Machine
  path: string
  value: string
  onChange: (value: string) => void
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  reveal?: DefinitionReveal
}) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const language = useFileLanguage(path)
  const languageId = languageIdForPath(path)
  const [lspClient, setLspClient] = useState<LspClient | null>(null)

  useEffect(() => {
    setLspClient(null)
    if (!languageId) return
    let cancelled = false
    let releaseFn: (() => void) | null = null
    void acquireLspClient(machine, worktreeId, languageId).then((acquired) => {
      if (cancelled) {
        acquired.release()
        return
      }
      releaseFn = acquired.release
      setLspClient(acquired.client)
    })
    return () => {
      cancelled = true
      releaseFn?.()
    }
  }, [languageId, worktreeId, machine])

  useEffect(() => {
    if (!lspClient || !languageId) return
    lspClient.openDocument(path, languageId, value)
    return () => lspClient.closeDocument(path)
  }, [languageId, lspClient, path])

  useEffect(() => {
    lspClient?.changeDocument(path, value)
  }, [lspClient, path, value])

  useEffect(() => {
    if (!lspClient) return
    return lspClient.subscribeDiagnostics(path, () => {
      const view = editorRef.current?.view
      if (view) forceLinting(view)
    })
  }, [lspClient, path])

  const completionExtension = useMemo(
    () =>
      autocompletion({
        override: lspClient
          ? [lspCompletionSource(lspClient, path), completeAnyWord]
          : [completeAnyWord],
      }),
    [lspClient, path],
  )
  const lspDiagnostics = useMemo(
    () =>
      lspClient
        ? linter(
            (view) =>
              codeMirrorDiagnostics(
                view.state.doc,
                lspClient.getDiagnostics(path),
              ),
            { delay: 150 },
          )
        : null,
    [lspClient, path],
  )

  const definitionNavigation = useMemo(
    () =>
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || (!event.ctrlKey && !event.metaKey))
            return false
          const position = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
          })
          if (position === null) return false

          const source = view.state.doc.toString()
          const quotedPath = quotedPathAt(source, position)
          const word = view.state.wordAt(position)
          const symbol = word ? source.slice(word.from, word.to) : ''
          const namespace = word
            ? source
                .slice(Math.max(0, word.from - 80), word.from)
                .match(/([A-Za-z_$][\w$]*)\.\s*$/)?.[1]
            : undefined
          const imported = findImportedSource(source, namespace ?? symbol)

          const openFallback = () => {
            if (
              !quotedPath &&
              !imported &&
              symbol &&
              revealDefinition(view, source, symbol)
            ) {
              return
            }

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
                onOpenDefinition(targetPath, {
                  symbol: imported?.revealSymbol ?? symbol,
                })
              })
              .catch(() => toast.error(`Could not resolve ${targetSource}`))
          }

          if (lspClient) {
            event.preventDefault()
            void lspClient
              .definition(path, offsetToPosition(view.state.doc, position))
              .then((definitions) => {
                const definition =
                  definitions.find((candidate) => candidate.path !== null) ??
                  definitions[0]
                if (!definition) {
                  openFallback()
                  return
                }
                if (!definition.path) {
                  toast.error('Definition is outside this worktree')
                  return
                }
                if (definition.path === path) {
                  revealRange(view, definition.range)
                  return
                }
                onOpenDefinition(definition.path, {
                  symbol,
                  range: definition.range,
                })
              })
              .catch(openFallback)
            return true
          }

          event.preventDefault()
          openFallback()
          return true
        },
      }),
    [lspClient, onOpenDefinition, path, worktreeId, machine],
  )

  useEffect(() => {
    const view = editorRef.current?.view
    if (!view || !reveal) return
    if (reveal.range) {
      revealRange(view, reveal.range)
    } else if (reveal.symbol) {
      revealDefinition(view, value, reveal.symbol)
    }
  }, [reveal, value])

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      height="100%"
      width="100%"
      aria-label={`Edit ${path}`}
      title="Ctrl/Cmd-click a symbol or import to go to its definition"
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
        loomCodeTheme,
        explicitHistoryKeymap,
        completionExtension,
        syntaxDiagnostics,
        ...(lspDiagnostics ? [lspDiagnostics] : []),
        lintGutter(),
        definitionNavigation,
        ...(language ? [language] : []),
      ]}
      onChange={onChange}
      className="h-full min-h-0 flex-1 overflow-hidden"
    />
  )
}
