export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface FileEdits {
  uri: string
  path: string
  edits: LspTextEdit[]
}

export interface SplitEdits {
  /** Edits targeting the document currently open in the editor. */
  currentEdits: LspTextEdit[]
  /** Edits targeting other files inside the worktree, in first-seen order. */
  otherFiles: FileEdits[]
  /** `create` / `rename` / `delete` operations, which DevDeck refuses. */
  unsupportedOps: string[]
  /** Uris the server wants to edit that do not resolve inside the worktree. */
  outsideRoot: string[]
}

interface WorkspaceEditLike {
  changes?: Record<string, LspTextEdit[]> | null
  documentChanges?: unknown[] | null
}

function isTextEdit(value: unknown): value is LspTextEdit {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LspTextEdit>
  return (
    typeof candidate.newText === 'string' &&
    !!candidate.range &&
    typeof candidate.range.start?.line === 'number' &&
    typeof candidate.range.end?.line === 'number'
  )
}

/**
 * Flattens a WorkspaceEdit's two possible shapes (`changes` map and
 * `documentChanges` array) into a per-uri view, split by whether the uri is the
 * open document, another worktree file, or something DevDeck cannot apply.
 */
export function splitWorkspaceEdit(
  edit: WorkspaceEditLike | null | undefined,
  currentUri: string,
  pathFromUri: (uri: string) => string | null,
): SplitEdits {
  const byUri = new Map<string, LspTextEdit[]>()
  const unsupportedOps: string[] = []

  const push = (uri: string, edits: LspTextEdit[]) => {
    const existing = byUri.get(uri)
    if (existing) existing.push(...edits)
    else byUri.set(uri, [...edits])
  }

  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    if (Array.isArray(edits)) push(uri, edits.filter(isTextEdit))
  }

  for (const change of edit?.documentChanges ?? []) {
    if (!change || typeof change !== 'object') continue
    const candidate = change as {
      kind?: string
      textDocument?: { uri?: string }
      edits?: unknown[]
    }
    if (typeof candidate.kind === 'string') {
      unsupportedOps.push(candidate.kind)
      continue
    }
    const uri = candidate.textDocument?.uri
    if (!uri || !Array.isArray(candidate.edits)) continue
    push(uri, candidate.edits.filter(isTextEdit))
  }

  const currentEdits: LspTextEdit[] = []
  const otherFiles: FileEdits[] = []
  const outsideRoot: string[] = []

  for (const [uri, edits] of byUri) {
    if (edits.length === 0) continue
    if (uri === currentUri) {
      currentEdits.push(...edits)
      continue
    }
    const path = pathFromUri(uri)
    if (!path) {
      outsideRoot.push(uri)
      continue
    }
    otherFiles.push({ uri, path, edits })
  }

  return { currentEdits, otherFiles, unsupportedOps, outsideRoot }
}

/** Character offset of an LSP position in a plain string, clamped to the text. */
export function positionToOffsetInText(text: string, position: LspPosition): number {
  let offset = 0
  let line = 0
  while (line < position.line) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return text.length
    offset = next + 1
    line += 1
  }
  const lineEnd = text.indexOf('\n', offset)
  const limit = lineEnd < 0 ? text.length : lineEnd
  return Math.min(limit, offset + Math.max(0, position.character))
}

/**
 * Applies edits to a string. Edits are applied back-to-front so that each
 * edit's offsets stay valid against the text it was computed from — LSP
 * guarantees the ranges within one file do not overlap.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      from: positionToOffsetInText(text, edit.range.start),
      to: positionToOffsetInText(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.from - a.from || b.to - a.to)

  let result = text
  for (const edit of resolved) {
    const from = Math.min(edit.from, edit.to)
    const to = Math.max(edit.from, edit.to)
    result = result.slice(0, from) + edit.newText + result.slice(to)
  }
  return result
}
