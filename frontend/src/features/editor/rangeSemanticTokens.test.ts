import { describe, expect, it, vi } from 'vitest'
import {
  createRangeSemanticTokensProvider,
  monacoLanguagesFor,
  semanticTokensLegendFrom,
  type SemanticTokensLegend,
} from './rangeSemanticTokens'

const LEGEND: SemanticTokensLegend = {
  tokenTypes: ['namespace', 'type', 'function'],
  tokenModifiers: ['definition', 'readonly'],
}

const initializeResponse = (legend: unknown) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    result: { capabilities: { semanticTokensProvider: { legend, full: true, range: true } } },
  })

describe('semanticTokensLegendFrom', () => {
  /** The legend is the index→name table for every number in a token payload.
   *  It arrives once, in the initialize response, and MonacoLspClient keeps its
   *  copy private — so it is read back off the wire. */
  it('reads the legend out of an initialize response', () => {
    expect(semanticTokensLegendFrom(initializeResponse(LEGEND))).toEqual(LEGEND)
  })

  it('ignores a server that offers no semantic tokens', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } })
    expect(semanticTokensLegendFrom(raw)).toBeNull()
  })

  it('ignores ordinary traffic', () => {
    expect(semanticTokensLegendFrom(JSON.stringify({ method: 'window/logMessage' }))).toBeNull()
    expect(semanticTokensLegendFrom(JSON.stringify({ id: 3, result: { data: [1, 2] } }))).toBeNull()
  })

  /** A malformed legend is worse than none: monaco would decode every token
   *  index against a table that cannot explain it. */
  it('rejects a legend that is not two string arrays', () => {
    expect(semanticTokensLegendFrom(initializeResponse({ tokenTypes: 'nope' }))).toBeNull()
    expect(
      semanticTokensLegendFrom(initializeResponse({ tokenTypes: [1, 2], tokenModifiers: [] })),
    ).toBeNull()
  })

  it('survives a frame that is not json', () => {
    expect(() => semanticTokensLegendFrom('<html>')).not.toThrow()
    expect(semanticTokensLegendFrom('<html>')).toBeNull()
  })
})

describe('monacoLanguagesFor', () => {
  /** One typescript-language-server answers for all four monaco ids, so a
   *  session opened as `typescript` must register against every one of them or
   *  a `.tsx` buffer silently has no range provider. */
  it('fans a typescript session out over all four JS/TS ids', () => {
    expect(monacoLanguagesFor('typescript')).toEqual([
      'typescript',
      'typescriptreact',
      'javascript',
      'javascriptreact',
    ])
  })

  it('leaves a one-language server alone', () => {
    expect(monacoLanguagesFor('go')).toEqual(['go'])
    expect(monacoLanguagesFor('rust')).toEqual(['rust'])
  })
})

const model = (uri: string) => ({ uri: { toString: () => uri } }) as never
const range = (startLine: number, endLine: number) =>
  ({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: 1,
  }) as never

describe('createRangeSemanticTokensProvider', () => {
  it('reports the server legend monaco decodes tokens with', () => {
    const provider = createRangeSemanticTokensProvider(LEGEND, async () => null)
    expect(provider.getLegend()).toEqual(LEGEND)
  })

  /** Monaco counts lines and columns from 1, LSP from 0. Off by one here and
   *  every token lands a line away from the text it should paint. */
  it('converts monaco’s 1-based range to LSP’s 0-based one', async () => {
    const request = vi.fn(async () => ({ data: [0, 0, 3, 0, 0] }))
    const provider = createRangeSemanticTokensProvider(LEGEND, request)

    await provider.provideDocumentRangeSemanticTokens(
      model('file:///w/Big.go'),
      range(10, 42),
      null as never,
    )

    expect(request).toHaveBeenCalledWith('file:///w/Big.go', {
      start: { line: 9, character: 0 },
      end: { line: 41, character: 0 },
    })
  })

  it('hands monaco the Uint32Array it requires', async () => {
    const provider = createRangeSemanticTokensProvider(LEGEND, async () => ({
      resultId: '7',
      data: [0, 0, 3, 2, 1],
    }))

    const result = await provider.provideDocumentRangeSemanticTokens(
      model('file:///w/Big.go'),
      range(1, 5),
      null as never,
    )

    expect(result?.data).toBeInstanceOf(Uint32Array)
    expect(Array.from(result?.data ?? [])).toEqual([0, 0, 3, 2, 1])
    expect(result?.resultId).toBe('7')
  })

  /**
   * A viewport can still exceed the server's cap — one enormous single line
   * will do it. Monaco drops a null answer and re-asks on the next scroll or
   * edit; a rejection would surface as an unexpected error and colour nothing
   * either way, so the failure is swallowed deliberately.
   */
  it('answers null when the server refuses the range', async () => {
    const provider = createRangeSemanticTokensProvider(LEGEND, async () => {
      throw new Error('semantic tokens: range too large (150768 > 100000)')
    })

    await expect(
      provider.provideDocumentRangeSemanticTokens(model('file:///w/Big.go'), range(1, 9), null as never),
    ).resolves.toBeNull()
  })

  it('answers null for an empty result rather than an empty token set', async () => {
    const provider = createRangeSemanticTokensProvider(LEGEND, async () => null)
    await expect(
      provider.provideDocumentRangeSemanticTokens(model('file:///w/Big.go'), range(1, 9), null as never),
    ).resolves.toBeNull()
  })
})
