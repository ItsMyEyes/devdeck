/**
 * DevDeck's own `textDocument/references` path — "who calls this function?".
 *
 * `MonacoLspClient` registers a reference provider of its own, but it cannot
 * answer with a location in a file the user has not opened. Its
 * `provideReferences` maps *every* result through
 * `TextDocumentSynchronizer.translateBackRange`, which looks the target uri up
 * in the set of loaded Monaco models and **throws** when there is none:
 *
 *     translateBackRange(textDocument, range) {
 *       const textModel = this._managedModelsReverse.get(textDocument.uri.toLowerCase())
 *       if (!textModel) throw new Error(`No text model for uri ${uri}`)
 *
 * One unopened file is therefore enough to reject the whole batch. Monaco
 * swallows the rejection (`getLocationLinks` catches per provider via
 * `onUnexpectedExternalError`) and the peek widget reports no results even
 * though the server answered correctly.
 *
 * For go-to-definition that failure mode is occasional — plenty of definitions
 * are in the current file. For references it is the normal case: the whole
 * point of the feature is finding call sites elsewhere, so the built-in
 * provider fails almost every time it is asked.
 *
 * So DevDeck registers a second provider that talks to the server over the
 * transport's private request channel and builds Monaco locations directly,
 * without consulting the model registry. Monaco merges results from every
 * registered provider and ignores the ones that reject, so the built-in
 * provider keeps serving the all-files-open case and this one covers the rest.
 * Selecting a result routes the foreign uri to `registerEditorOpener`, which
 * opens it as a DevDeck tab. (Same shape as lspDefinition.ts and lspRename.ts,
 * which work around the same limitation for their own requests.)
 *
 * Unlike lspDefinition.ts, results are **not** filtered to cross-file ones.
 * Dropping same-file references would hide every local call site whenever the
 * built-in provider has thrown — which, per above, is most of the time.
 * Returning them alongside the built-in provider's own answer is safe:
 * monaco's `ReferencesModel` sorts by (uri, range) and collapses adjacent
 * equal entries, so an overlap between the two providers dedupes itself.
 */

import type { LspPosition, LspRange } from './lspDefinition'

export type { LspPosition, LspRange } from './lspDefinition'

export interface ReferenceTarget {
  uri: string
  range: LspRange
}

/** Monaco range, 1-based on both axes, from an LSP range, 0-based on both. */
export function toMonacoRange(range: LspRange) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/**
 * `textDocument/references` is specified to answer with `Location[]` or `null`,
 * but a lone `Location` is accepted too so a server that returns one is not
 * silently ignored. Malformed entries are skipped rather than thrown on: a
 * single bad element must not cost the user every other call site.
 */
export function normalizeReferenceResult(result: unknown): ReferenceTarget[] {
  if (result === null || result === undefined) return []

  const entries = Array.isArray(result) ? result : [result]
  const targets: ReferenceTarget[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
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
