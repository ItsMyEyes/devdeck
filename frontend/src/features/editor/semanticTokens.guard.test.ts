import { describe, expect, it } from 'vitest'

/**
 * Semantic highlighting hangs off two things monaco gives no compile-time
 * guarantee about, so both are pinned here.
 *
 * 1. `DocumentSemanticTokensFeature` lives at a deep path that only resolves
 *    through monaco's `./*` export wildcard. `features/register.all` does NOT
 *    include it — it ships `viewportSemanticTokens` alone, which serves *range*
 *    providers, and `MonacoLspClient` registers only a document provider. If
 *    this path moves in a monaco upgrade, the import in `monacoSetup.ts` dies
 *    silently and every identifier goes back to one flat colour.
 *
 * 2. The feature is instantiated once, when the first editor is created, so the
 *    import must stay in `monacoSetup.ts` (which runs before any editor exists)
 *    rather than being reached lazily through the LSP client.
 */
describe('semantic tokens wiring', () => {
  it('resolves the DocumentSemanticTokensFeature module', async () => {
    const mod = await import(
      'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
    )
    expect(typeof mod.DocumentSemanticTokensFeature).toBe('function')
  })

  it('is registered by monacoSetup, before the first editor is constructed', async () => {
    const setup = await import('./monacoSetup?raw')
    expect(setup.default).toContain(
      "import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'",
    )
  })
})
