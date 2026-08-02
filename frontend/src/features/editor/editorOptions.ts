import type { editor } from 'monaco-editor/editor'

/** Pure so the VS Code mode mapping is testable without mounting an editor.
 *  `overrides` wins over both modes — surfaces like the read-only skill viewer
 *  and the word-wrapped markdown editor layer their own options on top. */
export function buildEditorOptions(
  vscodeMode: boolean,
  overrides: editor.IStandaloneEditorConstructionOptions = {},
): editor.IStandaloneEditorConstructionOptions {
  return {
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.5,
    lineNumbers: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    tabSize: 2,
    insertSpaces: true,
    smoothScrolling: true,
    padding: { top: 8, bottom: 8 },
    scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10 },
    minimap: { enabled: vscodeMode },
    stickyScroll: { enabled: vscodeMode },
    folding: vscodeMode,
    glyphMargin: vscodeMode,
    occurrencesHighlight: vscodeMode ? 'singleFile' : 'off',
    renderLineHighlight: vscodeMode ? 'all' : 'line',
    matchBrackets: vscodeMode ? 'always' : 'near',
    bracketPairColorization: { enabled: vscodeMode },
    guides: { indentation: vscodeMode, bracketPairs: vscodeMode },
    ...overrides,
  }
}
