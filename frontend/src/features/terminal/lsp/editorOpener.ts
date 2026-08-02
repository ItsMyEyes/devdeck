import type { RangeReveal } from '@/features/editor/reveal'

interface MonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * Backs `monaco.editor.registerEditorOpener`, monaco's supported hook for
 * "go to definition resolved to a different file".
 *
 * Without it, standalone monaco does nothing at all for a model it does not
 * already have — which is how the previous integration lost cross-file
 * navigation. Returning `true` claims the navigation; returning `false` lets
 * monaco fall back, which is the right answer for a uri outside this worktree
 * (a stdlib or module-cache path the runtime resolved but DevDeck cannot open).
 */
export function createEditorOpener({
  pathFromUri,
  openPath,
}: {
  pathFromUri: (uri: string) => string | null
  openPath: (path: string, reveal?: RangeReveal) => void
}) {
  return (uri: string, range?: MonacoRange): boolean => {
    const path = pathFromUri(uri)
    if (!path) return false
    openPath(
      path,
      range
        ? {
            startLine: range.startLineNumber,
            startColumn: range.startColumn,
            endLine: range.endLineNumber,
            endColumn: range.endColumn,
          }
        : undefined,
    )
    return true
  }
}
