import { describe, expect, it } from 'vitest'

/** monaco exports its native LSP client only from the package root, which also
 *  registers the 12 MB TypeScript language feature. We therefore reach it by
 *  path through a Vite alias. That path is outside monaco's `exports` map, so
 *  this test is the only thing standing between a monaco upgrade and a broken
 *  editor. If it fails, find the new location of MonacoLspClient and update the
 *  alias in vite.config.ts. */
describe('monaco-lsp-client alias', () => {
  it('resolves and exports MonacoLspClient', async () => {
    const mod = await import('monaco-lsp-client')
    expect(typeof mod.MonacoLspClient).toBe('function')
  })
})
