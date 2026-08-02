/** Content search's "open at line" entry point. 1-based line and column, matching
 *  both ripgrep's output and Monaco's own coordinate system. Kept structurally
 *  identical to the interface `PlainCodeEditor.tsx` exports today so existing
 *  callers in SSHShellPane, SSHFileEditor, FileEditor and ContentSearchPanel
 *  need no changes. */
export interface LineReveal {
  line: number
  column?: number
}

/** A definition jump or an LSP range result. */
export interface RangeReveal {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export type EditorReveal = LineReveal | RangeReveal

export function isRangeReveal(reveal: EditorReveal): reveal is RangeReveal {
  return 'startLine' in reveal
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/** Pure so the clamping is testable without an editor. A stale reveal can point
 *  past the end of a document that has since shrunk; clamping keeps that a
 *  no-op scroll rather than a thrown range error. */
export function toMonacoRange(
  reveal: EditorReveal,
  lineCount: number,
  lineMaxColumn: (line: number) => number,
) {
  if (isRangeReveal(reveal)) {
    const startLineNumber = clamp(reveal.startLine, 1, lineCount)
    const endLineNumber = clamp(reveal.endLine, 1, lineCount)
    return {
      startLineNumber,
      startColumn: clamp(reveal.startColumn, 1, lineMaxColumn(startLineNumber)),
      endLineNumber,
      endColumn: clamp(reveal.endColumn, 1, lineMaxColumn(endLineNumber)),
    }
  }
  const line = clamp(reveal.line, 1, lineCount)
  const column = clamp(reveal.column ?? 1, 1, lineMaxColumn(line))
  return {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  }
}
