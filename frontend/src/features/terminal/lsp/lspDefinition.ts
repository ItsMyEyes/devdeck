/**
 * DevDeck's own `textDocument/definition` path.
 *
 * `MonacoLspClient` registers a definition provider of its own, but it cannot
 * answer a cross-file definition. Its `toMonacoLocation` runs every result
 * through `TextDocumentSynchronizer.translateBackRange`, which looks the target
 * uri up in the set of loaded Monaco models and **throws** when there is none:
 *
 *     translateBackRange(textDocument, range) {
 *       const textModel = this._managedModelsReverse.get(textDocument.uri.toLowerCase())
 *       if (!textModel) throw new Error(`No text model for uri ${uri}`)
 *
 * A definition in a file the user has not opened therefore rejects the whole
 * provider, Monaco swallows the rejection, and the user sees
 * "No definition found for 'X'" even though the server answered correctly.
 * (The same limitation is why cross-file rename is custom — see lspRename.ts.)
 *
 * So DevDeck registers a second provider that talks to the server over the
 * transport's private request channel and builds Monaco locations directly,
 * without consulting the model registry. Monaco merges results from every
 * registered provider and ignores the ones that reject, so the built-in
 * provider keeps serving same-file definitions and this one covers the rest.
 * Monaco then routes the foreign uri to `registerEditorOpener`, which opens it
 * as a DevDeck tab.
 */

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface DefinitionTarget {
  uri: string
  range: LspRange
}

/**
 * `textDocument/definition` may answer with a single `Location`, an array of
 * `Location`, or an array of `LocationLink` — gopls and rust-analyzer use
 * different shapes, and a server may return `null` for "no definition".
 * Normalises all of them to a flat list.
 *
 * For a `LocationLink`, `targetSelectionRange` (the identifier itself) is
 * preferred over `targetRange` (the whole declaration body), so jumping lands
 * the cursor on the name rather than selecting the entire function.
 */
export function normalizeDefinitionResult(result: unknown): DefinitionTarget[] {
  if (result === null || result === undefined) return []

  const entries = Array.isArray(result) ? result : [result]
  const targets: DefinitionTarget[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue

    const link = entry as { targetUri?: unknown; targetRange?: unknown; targetSelectionRange?: unknown }
    if (typeof link.targetUri === 'string') {
      const range = (link.targetSelectionRange ?? link.targetRange) as LspRange | undefined
      if (isRange(range)) targets.push({ uri: link.targetUri, range })
      continue
    }

    const location = entry as { uri?: unknown; range?: unknown }
    if (typeof location.uri === 'string' && isRange(location.range)) {
      targets.push({ uri: location.uri, range: location.range })
    }
  }

  return targets
}

function isRange(value: unknown): value is LspRange {
  if (!value || typeof value !== 'object') return false
  const range = value as { start?: unknown; end?: unknown }
  return isPosition(range.start) && isPosition(range.end)
}

function isPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as { line?: unknown; character?: unknown }
  return typeof position.line === 'number' && typeof position.character === 'number'
}

/**
 * Drops targets that live in `currentUri`. Those are already served correctly
 * by `MonacoLspClient`'s own provider — the model is loaded, so its
 * `translateBackRange` succeeds — and returning them here too would make Monaco
 * show a peek widget listing the same location twice.
 *
 * Uri comparison is case-insensitive to match `translateBackRange`, which
 * lowercases before its own lookup.
 */
export function crossFileTargets(targets: DefinitionTarget[], currentUri: string): DefinitionTarget[] {
  const current = currentUri.toLowerCase()
  return targets.filter((target) => target.uri.toLowerCase() !== current)
}
