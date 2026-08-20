import * as monaco from 'monaco-editor'
import type { LspSession } from '@/features/terminal/lsp/lspSession'
import { requestInlineCompletion, type GroundingSymbol } from '@/lib/api'

const DEFAULT_DEBOUNCE_MS = 300
const PREFIX_MAX_CHARS = 4000
const SUFFIX_MAX_CHARS = 2000
const GROUNDING_COMPLETION_LIMIT = 20
const GROUNDING_SYMBOL_LIMIT = 50

interface DocSymbolCacheEntry {
  version: number
  symbols: GroundingSymbol[]
}

interface LastSuggestion {
  prefix: string
  suggestion: string
}

interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
}

interface LspDocumentSymbol {
  name: string
  kind: number
  detail?: string
}

interface LspSymbolInformation {
  name: string
}

const LSP_KIND_NAMES: Record<number, string> = {
  3: 'function', 6: 'method', 12: 'function', 5: 'field', 13: 'variable', 7: 'class', 22: 'struct', 8: 'interface',
}

function kindName(kind: number | undefined): string {
  if (kind === undefined) return 'symbol'
  return LSP_KIND_NAMES[kind] ?? 'symbol'
}

const CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\s*\(/g

/** Creates a Monaco inline-completions provider that grounds every
 *  suggestion against the file's live LSP session and validates any
 *  referenced call before rendering it — failing closed (dropping the
 *  suggestion) rather than showing an unresolved reference.
 *  `debounceMs` defaults to 300; pass 0 in tests to skip the wait.
 *
 *  `expectedUri`, when provided, is the exact model uri this provider
 *  instance is responsible for (the caller's own open file). This matters
 *  because `monaco.languages.registerInlineCompletionsProvider` registers
 *  into monaco's *global* per-language provider registry: every provider
 *  registered for a language is invoked against whichever model is
 *  currently being edited, regardless of which component registered it. In
 *  a split-pane layout, two open files of the same language each register
 *  their own provider bound to their own session — without this check,
 *  editing file A would also invoke file B's provider (with file B's stale
 *  `lastSuggestion` cache and file B's LSP session for grounding/validation)
 *  against file A's buffer. */
export function createInlineCompletionsProvider(
  getSession: () => LspSession | null,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
  expectedUri?: string,
): monaco.languages.InlineCompletionsProvider {
  const docSymbolCache = new Map<string, DocSymbolCacheEntry>()
  let lastSuggestion: LastSuggestion | null = null
  let inFlight: AbortController | null = null
  // Normalized once, through monaco's own Uri parser, so comparisons against
  // `model.uri.toString()` (also monaco-normalized) can't diverge on
  // encoding details between this string and the raw uri the caller passed.
  const expectedModelUri = expectedUri !== undefined ? monaco.Uri.parse(expectedUri).toString() : undefined

  async function gatherGroundingSymbols(
    session: LspSession,
    uri: string,
    version: number,
    position: monaco.Position,
  ): Promise<GroundingSymbol[]> {
    const completionPromise = session.transport
      .request<{ items?: LspCompletionItem[] } | LspCompletionItem[] | null>('textDocument/completion', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })
      .catch(() => null)

    let docSymbols: GroundingSymbol[]
    const cached = docSymbolCache.get(uri)
    if (cached && cached.version === version) {
      docSymbols = cached.symbols
    } else {
      const raw = await session.transport
        .request<LspDocumentSymbol[] | null>('textDocument/documentSymbol', { textDocument: { uri } })
        .catch(() => null)
      docSymbols = (raw ?? []).slice(0, GROUNDING_SYMBOL_LIMIT).map((s) => ({
        name: s.name,
        kind: kindName(s.kind),
        detail: s.detail ?? '',
      }))
      docSymbolCache.set(uri, { version, symbols: docSymbols })
    }

    const completionRaw = await completionPromise
    const items = Array.isArray(completionRaw) ? completionRaw : (completionRaw?.items ?? [])
    const completionSymbols: GroundingSymbol[] = items.slice(0, GROUNDING_COMPLETION_LIMIT).map((item) => ({
      name: item.label,
      kind: kindName(item.kind),
      detail: item.detail ?? '',
    }))

    return [...completionSymbols, ...docSymbols]
  }

  async function validateCompletion(session: LspSession, text: string): Promise<boolean> {
    const firstLine = text.split('\n')[0] ?? ''
    const names = new Set<string>()
    for (const match of firstLine.matchAll(CALL_PATTERN)) {
      names.add(match[1])
    }
    if (names.size === 0) return true

    for (const name of names) {
      const result = await session.transport
        .request<LspSymbolInformation[] | null>('workspace/symbol', { query: name })
        .catch(() => null)
      const resolved = (result ?? []).some((sym) => sym.name === name)
      if (!resolved) return false
    }
    return true
  }

  return {
    async provideInlineCompletions(model, position, _context, token) {
      if (expectedModelUri !== undefined && model.uri.toString() !== expectedModelUri) return undefined

      const session = getSession()
      if (!session) return undefined

      const fullPrefix = model.getValueInRange({
        startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
      })

      if (lastSuggestion && fullPrefix.startsWith(lastSuggestion.prefix)) {
        const typed = fullPrefix.slice(lastSuggestion.prefix.length)
        if (lastSuggestion.suggestion.startsWith(typed)) {
          const remainder = lastSuggestion.suggestion.slice(typed.length)
          if (remainder.length > 0) {
            return { items: [{ insertText: remainder, range: monaco.Range.fromPositions(position, position) }] }
          }
        }
      }

      inFlight?.abort()
      const controller = new AbortController()
      inFlight = controller

      if (debounceMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, debounceMs))
        if (controller.signal.aborted || token.isCancellationRequested) return undefined
      }

      const uri = model.uri.toString()
      const version = model.getVersionId()
      const groundingSymbols = await gatherGroundingSymbols(session, uri, version, position)
      if (controller.signal.aborted || token.isCancellationRequested) return undefined

      const prefix = fullPrefix.slice(-PREFIX_MAX_CHARS)
      const lastLine = model.getLineCount()
      const suffix = model
        .getValueInRange({
          startLineNumber: position.lineNumber, startColumn: position.column,
          endLineNumber: lastLine, endColumn: model.getLineMaxColumn(lastLine),
        })
        .slice(0, SUFFIX_MAX_CHARS)

      const response = await requestInlineCompletion(
        { prefix, suffix, language: model.getLanguageId(), groundingSymbols },
        { signal: controller.signal },
      ).catch(() => undefined)
      if (!response || controller.signal.aborted || token.isCancellationRequested) return undefined

      const valid = await validateCompletion(session, response.completion)
      if (!valid || controller.signal.aborted || token.isCancellationRequested) return undefined

      lastSuggestion = { prefix: fullPrefix, suggestion: response.completion }
      return { items: [{ insertText: response.completion, range: monaco.Range.fromPositions(position, position) }] }
    },
    disposeInlineCompletions() {},
  }
}
