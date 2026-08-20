import { describe, expect, it } from 'vitest'
import { DevDeckLspTransport } from './lspTransport'

type Listener = (event: unknown) => void

/** Minimal stand-in for the browser WebSocket the transport is handed —
 *  mirrors the fake in lspTransport.test.ts. */
class FakeSocket {
  static readonly OPEN = 1

  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  send(message: string) {
    this.sent.push(message)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = FakeSocket.OPEN
    for (const listener of this.listeners.get('open') ?? []) listener({})
  }
}

const FILE = 'file:///Users/kiyora/src/core/internal/cli/root.go'
const PLACEHOLDER = 'inmemory://devdeck/m-1:w-2:internal/cli/root.go'

function goTransport() {
  const socket = new FakeSocket()
  const transport = new DevDeckLspTransport(socket as unknown as WebSocket, 'go', () => [FILE])
  socket.open()
  return { socket, transport }
}

function sentMethods(socket: FakeSocket) {
  return socket.sent.map((raw) => (JSON.parse(raw) as { method?: string }).method)
}

/**
 * Every uri DevDeck addresses a language server with is a `file://` one, built
 * from the worktree root the backend reports in its `ready` frame. But
 * `MonacoLspClient`'s `TextDocumentSynchronizer` announces *every* model monaco
 * holds, and `MonacoEditor` deliberately builds each code model on a synthetic
 * `inmemory://devdeck/…` uri first, swapping to the real one only once the LSP
 * session resolves (see its `uri` prop doc).
 *
 * gopls answers a non-file uri with a hard `-32700 "DocumentURI scheme is not
 * 'file'"` — verified against gopls v0.20 over a real stdio session — and
 * returns the same for the `textDocument/semanticTokens/full` monaco fires
 * against that placeholder model a moment later. Monaco files a semantic-tokens
 * error under "temporarily unavailable" and never retries, so a single doomed
 * exchange is enough to strand a file on the monarch grammar.
 */
describe('DevDeckLspTransport document scheme filter', () => {
  it.each(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose'])(
    'drops %s for a non-file document',
    (method) => {
      const { socket, transport } = goTransport()
      void transport.send({
        jsonrpc: '2.0',
        method,
        params: { textDocument: { uri: PLACEHOLDER, languageId: 'go', version: 1, text: '' } },
      })
      expect(socket.sent).toEqual([])
    },
  )

  it('still announces a real file:// document', () => {
    const { socket, transport } = goTransport()
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: FILE, languageId: 'go', version: 1, text: '' } },
    })
    expect(sentMethods(socket)).toEqual(['textDocument/didOpen'])
  })

  /** The filter is about *documents*, so it must not reach anything else — an
   *  `initialize` carries no textDocument and must always go out. */
  it('leaves non-document messages alone', () => {
    const { socket, transport } = goTransport()
    void transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(sentMethods(socket)).toEqual(['initialize'])
  })

  /** A request addressing a placeholder is monaco's to make, not ours to
   *  suppress — dropping a message that carries an id would hang its caller,
   *  which is exactly what `answerWithoutServer` exists to avoid. Only the
   *  three fire-and-forget sync notifications are filtered. */
  it('does not drop a request that happens to name a non-file document', () => {
    const { socket, transport } = goTransport()
    void transport.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'textDocument/semanticTokens/full',
      params: { textDocument: { uri: PLACEHOLDER } },
    })
    expect(sentMethods(socket)).toEqual(['textDocument/semanticTokens/full'])
  })
})
