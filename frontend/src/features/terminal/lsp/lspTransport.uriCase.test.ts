import { describe, expect, it } from 'vitest'
import { DevDeckLspTransport, restoreDocumentUriCase } from './lspTransport'

type Listener = (event: unknown) => void

/** Minimal stand-in for the browser WebSocket the transport is handed —
 *  mirrors the fake in lspTransport.test.ts. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeSocket.CONNECTING
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
    this.readyState = FakeSocket.CLOSED
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.emit('open', {})
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const REAL = 'file:///Users/kiyora/Documents/superapps/core/internal/cli/root.go'
const LOWER = REAL.toLowerCase()

function goTransport(models: string[]) {
  const socket = new FakeSocket()
  const transport = new DevDeckLspTransport(socket as unknown as WebSocket, 'go', () => models)
  socket.open()
  return { socket, transport }
}

function sentUris(socket: FakeSocket) {
  return socket.sent.map(
    (raw) => (JSON.parse(raw) as { params?: { textDocument?: { uri?: string } } }).params?.textDocument?.uri,
  )
}

describe('restoreDocumentUriCase', () => {
  it('recovers the real capitalisation from the open model list', () => {
    expect(restoreDocumentUriCase(LOWER, [REAL])).toBe(REAL)
  })

  it('leaves a uri alone when nothing matches it', () => {
    expect(restoreDocumentUriCase(LOWER, ['file:///other/main.go'])).toBe(LOWER)
    expect(restoreDocumentUriCase('inmemory://devdeck/a', [REAL])).toBe('inmemory://devdeck/a')
  })

  it('is a no-op for a uri whose case is already right', () => {
    expect(restoreDocumentUriCase(REAL, [REAL])).toBe(REAL)
  })
})

describe('DevDeckLspTransport document uri case', () => {
  it('restores the real case on didOpen', () => {
    const { socket, transport } = goTransport([REAL])
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LOWER, languageId: 'go', version: 1, text: '' } },
    })
    expect(sentUris(socket)).toEqual([REAL])
  })

  it('keeps didChange and didClose on the uri the document was opened under', () => {
    // The model is gone from the list by the time didClose is sent — monaco
    // fires `onWillDispose` as it is removing the model — so the mapping has to
    // survive independently of the live model list.
    const models = [REAL]
    const { socket, transport } = goTransport(models)
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LOWER, languageId: 'go', version: 1, text: '' } },
    })
    models.length = 0
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri: LOWER, version: 2 }, contentChanges: [] },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: LOWER } },
    })
    expect(sentUris(socket)).toEqual([REAL, REAL, REAL])
  })

  it('forgets the mapping once the document closes', () => {
    const models = [REAL]
    const { socket, transport } = goTransport(models)
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LOWER, languageId: 'go', version: 1, text: '' } },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: LOWER } },
    })
    models.length = 0
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri: LOWER, version: 2 }, contentChanges: [] },
    })
    expect(sentUris(socket)).toEqual([REAL, REAL, LOWER])
  })

  /** The case repair is a best-effort lookup, not a gate: a document monaco
   *  has already dropped from its model list still has to reach the server
   *  addressed as it was. Uses a second `file://` path rather than the
   *  `inmemory://` placeholder this once asserted on — those never reach the
   *  server at all now, see lspTransport.scheme.test.ts. */
  it('passes a uri with no matching model through untouched', () => {
    const { socket, transport } = goTransport([REAL])
    const uri = 'file:///Users/kiyora/Documents/superapps/core/internal/cli/Other.go'
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'go', version: 1, text: '' } },
    })
    expect(sentUris(socket)).toEqual([uri])
  })

  it('still drops a foreign-language document after restoring its case', () => {
    const { socket, transport } = goTransport([REAL])
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LOWER, languageId: 'typescript', version: 1, text: '' } },
    })
    expect(socket.sent).toEqual([])
  })

  it('leaves messages alone when no model list is supplied', () => {
    const socket = new FakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket, 'go')
    socket.open()
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LOWER, languageId: 'go', version: 1, text: '' } },
    })
    expect(sentUris(socket)).toEqual([LOWER])
  })

  it('does not touch a non-document message', () => {
    const { socket, transport } = goTransport([REAL])
    void transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/definition',
      params: { textDocument: { uri: REAL }, position: { line: 0, character: 0 } },
    })
    expect(sentUris(socket)).toEqual([REAL])
  })
})
