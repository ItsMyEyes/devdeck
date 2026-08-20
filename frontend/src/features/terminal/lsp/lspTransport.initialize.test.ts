import { describe, expect, it } from 'vitest'
import { configurationItemResult, rewriteInitialize, serverSettings } from './lspTransport'

const ROOT = 'file:///home/dev/worktrees/abc'

describe('rewriteInitialize', () => {
  it('injects rootUri and workspaceFolders into an initialize request', () => {
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null } },
      ROOT,
    )
    const params = out.params as Record<string, unknown>
    expect(params.rootUri).toBe(ROOT)
    expect(params.workspaceFolders).toEqual([{ uri: ROOT, name: 'worktree' }])
  })

  it('preserves capabilities and every other param monaco sent', () => {
    const capabilities = { textDocument: { completion: {} } }
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, capabilities } },
      ROOT,
    )
    const params = out.params as Record<string, unknown>
    expect(params.capabilities).toEqual(capabilities)
    expect(params.processId).toBeNull()
  })

  it('leaves every other method untouched', () => {
    const message = { jsonrpc: '2.0' as const, method: 'textDocument/didOpen', params: { a: 1 } }
    expect(rewriteInitialize(message, ROOT)).toBe(message)
  })

  it('tolerates a missing params object', () => {
    const out = rewriteInitialize({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ROOT)
    expect((out.params as Record<string, unknown>).rootUri).toBe(ROOT)
  })

  // Without this gopls answers `initialize` with no semanticTokensProvider at
  // all (verified against gopls v0.22 over stdio), so monaco registers no
  // semantic-tokens provider and function names never get their own colour.
  it('asks gopls to turn semantic tokens on', () => {
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ROOT,
      'go',
    )
    expect((out.params as Record<string, unknown>).initializationOptions).toEqual({
      semanticTokens: true,
    })
  })

  it('merges settings over any initializationOptions the client already sent', () => {
    const out = rewriteInitialize(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { initializationOptions: { build: { directoryFilters: ['-node_modules'] } } },
      },
      ROOT,
      'go',
    )
    expect((out.params as Record<string, unknown>).initializationOptions).toEqual({
      build: { directoryFilters: ['-node_modules'] },
      semanticTokens: true,
    })
  })

  it('sends no initializationOptions for a server with nothing to configure', () => {
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ROOT,
      'typescript',
    )
    expect((out.params as Record<string, unknown>).initializationOptions).toBeUndefined()
    expect(serverSettings('typescript')).toBeUndefined()
  })
})

describe('configurationItemResult', () => {
  // gopls re-reads its settings through workspace/configuration after
  // initialize, and that read replaces the initializationOptions copy — so
  // answering null here would switch semantic tokens straight back off.
  it('repeats the settings for the section the server asks for', () => {
    expect(configurationItemResult('go', 'gopls')).toEqual({ semanticTokens: true })
  })

  it('nests them under the section name when the item asks for everything', () => {
    expect(configurationItemResult('go', undefined)).toEqual({ gopls: { semanticTokens: true } })
  })

  it('answers null for another section, an unconfigured server, and no language', () => {
    expect(configurationItemResult('go', 'rust-analyzer')).toBeNull()
    expect(configurationItemResult('typescript', 'typescript')).toBeNull()
    expect(configurationItemResult(undefined, 'gopls')).toBeNull()
  })
})
