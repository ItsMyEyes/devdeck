import { autocompletion, completeAnyWord } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useMemo } from 'react'
import {
  explicitHistoryKeymap,
  loomCodeTheme,
  syntaxDiagnostics,
  useFileLanguage,
} from './CodeFileEditor'

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
}: {
  path: string
  value: string
  onChange: (value: string) => void
  editorRef?: React.Ref<ReactCodeMirrorRef>
}) {
  const language = useFileLanguage(path)
  const completionExtension = useMemo(() => autocompletion({ override: [completeAnyWord] }), [])

  return (
    <CodeMirror
      ref={editorRef}
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
        loomCodeTheme,
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
