import type { languages } from 'monaco-editor/editor'
import { serverLanguage } from '@/features/terminal/lsp/lspTransport'

/**
 * Viewport semantic highlighting, for the files a language server refuses to
 * colour whole.
 *
 * gopls caps `textDocument/semanticTokens/full` at 100 000 bytes and answers
 * anything larger with a JSON-RPC *error* — verified against gopls v0.20:
 *
 *     semantic tokens: range …/usecase.go too large (150768 > 100000)
 *
 * Monaco treats a semantic-tokens error as "temporarily unavailable", keeps the
 * tokens it has (none) and never asks again, so the file spends its whole life
 * painted by the monarch grammar: keywords and strings coloured, every
 * identifier — function, type, parameter alike — flat. Nothing else about the
 * session is wrong, which is what makes it so confusing to look at; hover,
 * go-to-definition and diagnostics all keep working on the very same file.
 *
 * The cap is on the size of the *requested span*, not the file: the same server
 * answers `semanticTokens/range` for a viewport-sized slice of that same file
 * without complaint. Monaco is built for this — `ViewportSemanticTokensContribution`
 * re-asks per visible range whenever a model has no complete token set — but it
 * only runs if a *range* provider is registered, and `MonacoLspClient`
 * registers none. It advertises `requests: { range: true }` in its client
 * capabilities and then never installs the provider, so the server's range
 * support is offered and never used.
 *
 * This is that missing provider. It is registered per session (not per editor,
 * which is how DevDeck's definition and reference providers ended up answering
 * a single go-to-definition three times over) and addresses documents by the
 * model's own uri, which is exactly the string `didOpen` carried after
 * `restoreDocumentUriCase`.
 */

/** LSP's `semanticTokens/range` result, before it becomes monaco's shape. */
interface LspSemanticTokens {
  resultId?: string
  data?: number[]
}

/** What the server advertised in its `initialize` response. */
export interface SemanticTokensLegend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

interface InitializeResponse {
  result?: {
    capabilities?: {
      semanticTokensProvider?: { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } }
    }
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * Pulls the semantic-tokens legend out of a raw inbound frame, or null if that
 * frame is not an `initialize` response that offers one.
 *
 * The legend is the index→name table for every number in a token payload, so
 * monaco cannot colour a single token without it. It arrives exactly once, in
 * the `initialize` response, and `MonacoLspClient` keeps its copy private —
 * hence reading it back off the wire rather than asking the client for it.
 */
export function semanticTokensLegendFrom(raw: string): SemanticTokensLegend | null {
  let message: InitializeResponse
  try {
    message = JSON.parse(raw) as InitializeResponse
  } catch {
    return null
  }
  const legend = message.result?.capabilities?.semanticTokensProvider?.legend
  if (!legend) return null
  const { tokenTypes, tokenModifiers } = legend
  if (!isStringArray(tokenTypes) || !isStringArray(tokenModifiers)) return null
  return { tokenTypes, tokenModifiers }
}

/**
 * The monaco language ids one language server speaks for.
 *
 * `serverLanguage()` collapses the four JS/TS monaco ids onto the single
 * typescript-language-server process, so a session opened for `typescript` has
 * to register against all four or a `.tsx` buffer silently gets no provider.
 */
export function monacoLanguagesFor(language: string): string[] {
  if (serverLanguage(language) === 'typescript') {
    return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']
  }
  return [language]
}

/** Issues one `textDocument/semanticTokens/range`, in LSP's 0-based shape. */
export type RangeTokensRequest = (
  uri: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
) => Promise<LspSemanticTokens | null>

export function createRangeSemanticTokensProvider(
  legend: SemanticTokensLegend,
  request: RangeTokensRequest,
): languages.DocumentRangeSemanticTokensProvider {
  return {
    getLegend: () => legend,
    async provideDocumentRangeSemanticTokens(model, range) {
      const result = await request(model.uri.toString(true), {
        // Monaco counts lines and columns from 1, LSP from 0.
        start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
        end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
      }).catch(() => null)

      // `null` rather than a throw for a range the server still refuses — a
      // viewport over one enormous line can exceed the same cap. Monaco drops a
      // null answer and re-asks on the next scroll or edit, where a throw would
      // be reported as an unexpected error and colour nothing either way.
      if (!result?.data) return null
      return { resultId: result.resultId, data: Uint32Array.from(result.data) }
    },
  }
}
