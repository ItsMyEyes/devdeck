import { autocompletion, completeAnyWord } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror, { type EditorView, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef } from 'react'
import {
  explicitHistoryKeymap,
  devdeckCodeTheme,
  syntaxDiagnostics,
  useFileLanguage,
} from './CodeFileEditor'

/**
 * A one-shot request to scroll to and select a line (optionally a character
 * span within it) once this editor's document is ready — the SSH-side
 * "open at line" entry point for content search (worktree files reuse
 * CodeFileEditor's existing LSP `reveal`/`DefinitionReveal.range` instead;
 * see ExpandedTerminal.tsx's `openAtLine`). `requestId` must change on every
 * request — including re-opening the same line twice in a row — so the
 * reveal effect below re-fires instead of silently no-oping on an
 * unchanged {line, column, length} object.
 */
export interface LineReveal {
  line: number // 1-based
  column: number // 1-based; 0 means "unknown" (e.g. the grep fallback doesn't report columns) — selects from the start of the line
  length: number // characters to select after column; 0 or negative selects to the end of the line
  requestId: number
}

function revealLine(view: EditorView, reveal: LineReveal) {
  const doc = view.state.doc
  const lineNumber = Math.min(doc.lines, Math.max(1, reveal.line))
  const info = doc.line(lineNumber)
  const anchor = reveal.column > 0 ? Math.min(info.to, info.from + reveal.column - 1) : info.from
  const head = reveal.length > 0 ? Math.min(info.to, anchor + reveal.length) : info.to
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
  view.focus()
}

/**
 * CodeMirror wired with the same theme/keymap/syntax-error linting as
 * CodeFileEditor, minus everything LSP-specific (go-to-definition,
 * server-backed completion/diagnostics) — those are tied to a worktree's
 * local language servers, which don't exist for an arbitrary SSH host. Word
 * completion from the open buffer still works.
 */
export function PlainCodeEditor({
  path,
  value,
  onChange,
  editorRef,
  reveal,
}: {
  path: string
  value: string
  onChange: (value: string) => void
  editorRef?: React.Ref<ReactCodeMirrorRef>
  reveal?: LineReveal
}) {
  const language = useFileLanguage(path)
  const completionExtension = useMemo(() => autocompletion({ override: [completeAnyWord] }), [])
  const internalRef = useRef<ReactCodeMirrorRef | null>(null)

  useEffect(() => {
    const view = internalRef.current?.view
    if (!view || !reveal) return
    revealLine(view, reveal)
  }, [reveal])

  return (
    <CodeMirror
      ref={(instance) => {
        internalRef.current = instance
        if (typeof editorRef === 'function') editorRef(instance)
        else if (editorRef) (editorRef as React.RefObject<ReactCodeMirrorRef | null>).current = instance
      }}
      value={value}
      height="100%"
      width="100%"
      aria-label={`Edit ${path}`}
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
        completionExtension,
        syntaxDiagnostics,
        lintGutter(),
        ...(language ? [language] : []),
      ]}
      onChange={onChange}
      className="h-full min-h-0 flex-1 overflow-hidden"
    />
  )
}
