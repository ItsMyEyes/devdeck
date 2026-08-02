import { describe, expect, it } from 'vitest'
import { rewriteInitialize } from './lspTransport'

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
})
