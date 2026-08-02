import type { editor } from 'monaco-editor/editor'

export const DEVDECK_DARK = 'devdeck-dark'

/** Ported from `devdeckCodeTheme` + `oneDark` in the CodeMirror editor so the
 *  surface reads identically after the migration. Monaco token scopes replace
 *  Lezer highlight tags. */
export const devdeckDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f6672', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c678dd' },
    { token: 'string', foreground: '98c379' },
    { token: 'number', foreground: 'd19a66' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'function', foreground: '61afef' },
    { token: 'variable', foreground: 'e06c75' },
    { token: 'operator', foreground: '56b6c2' },
  ],
  colors: {
    'editor.background': '#090a0c',
    'editor.foreground': '#d8d8d4',
    'editorLineNumber.foreground': '#4a5059',
    'editorLineNumber.activeForeground': '#8b939f',
    'editor.lineHighlightBackground': '#11131600',
    'editor.selectionBackground': '#2c313a',
    'editorCursor.foreground': '#d8d8d4',
    'editorIndentGuide.background1': '#1c1f24',
    'editorGutter.background': '#090a0c',
    'editorWidget.background': '#0e1013',
    'editorWidget.border': '#1c1f24',
    'editorSuggestWidget.background': '#0e1013',
    'editorSuggestWidget.border': '#1c1f24',
    'editorSuggestWidget.selectedBackground': '#1c1f24',
    'editorHoverWidget.background': '#0e1013',
    'editorHoverWidget.border': '#1c1f24',
    'minimap.background': '#090a0c',
    'scrollbarSlider.background': '#1c1f2480',
    'scrollbarSlider.hoverBackground': '#2c313a80',
  },
}
