import type { editor } from 'monaco-editor/editor'

export const DEVDECK_DARK = 'devdeck-dark'

/**
 * Visual Studio Code's "Dark+" palette, the default VS Code dark theme.
 *
 * The migration originally shipped a port of the old CodeMirror `oneDark`
 * colours to keep the surface looking unchanged. Now that the editor *is*
 * Monaco — the same editor VS Code ships — matching Dark+ makes syntax
 * highlighting read exactly as it does in VS Code, which is the point of the
 * VS Code mode this theme pairs with.
 */
export const devdeckDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'string.escape', foreground: 'D7BA7D' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'regexp', foreground: 'D16969' },
    { token: 'type', foreground: '4EC9B0' },
    { token: 'type.identifier', foreground: '4EC9B0' },
    { token: 'namespace', foreground: '4EC9B0' },
    { token: 'struct', foreground: '4EC9B0' },
    { token: 'interface', foreground: 'B8D7A3' },
    { token: 'function', foreground: 'DCDCAA' },
    { token: 'identifier', foreground: '9CDCFE' },
    { token: 'variable', foreground: '9CDCFE' },
    { token: 'variable.predefined', foreground: '4FC1FF' },
    { token: 'constant', foreground: '4FC1FF' },
    { token: 'parameter', foreground: '9CDCFE' },
    { token: 'property', foreground: '9CDCFE' },
    { token: 'operator', foreground: 'D4D4D4' },
    { token: 'delimiter', foreground: 'D4D4D4' },
    { token: 'tag', foreground: '569CD6' },
    { token: 'attribute.name', foreground: '9CDCFE' },
    { token: 'attribute.value', foreground: 'CE9178' },
    { token: 'metatag', foreground: '569CD6' },
    { token: 'annotation', foreground: 'DCDCAA' },
    { token: 'invalid', foreground: 'F44747' },
  ],
  colors: {
    'editor.background': '#1E1E1E',
    'editor.foreground': '#D4D4D4',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#C6C6C6',
    'editor.lineHighlightBackground': '#2A2D2E40',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editor.selectionHighlightBackground': '#ADD6FF26',
    'editor.wordHighlightBackground': '#575757B8',
    'editor.wordHighlightStrongBackground': '#004972B8',
    'editor.findMatchBackground': '#515C6A',
    'editor.findMatchHighlightBackground': '#EA5C0055',
    'editorCursor.foreground': '#AEAFAD',
    'editorWhitespace.foreground': '#3B3B3B',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorGutter.background': '#1E1E1E',
    'editorBracketMatch.background': '#0064001A',
    'editorBracketMatch.border': '#888888',
    'editorBracketHighlight.foreground1': '#FFD700',
    'editorBracketHighlight.foreground2': '#DA70D6',
    'editorBracketHighlight.foreground3': '#179FFF',
    'editorError.foreground': '#F14C4C',
    'editorWarning.foreground': '#CCA700',
    'editorInfo.foreground': '#3794FF',
    'editorWidget.background': '#252526',
    'editorWidget.border': '#454545',
    'editorSuggestWidget.background': '#252526',
    'editorSuggestWidget.border': '#454545',
    'editorSuggestWidget.selectedBackground': '#04395E',
    'editorSuggestWidget.highlightForeground': '#2AAAFF',
    'editorHoverWidget.background': '#252526',
    'editorHoverWidget.border': '#454545',
    'editorStickyScroll.background': '#1E1E1E',
    'editorOverviewRuler.border': '#7F7F7F4D',
    'minimap.background': '#1E1E1E',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
  },
}
