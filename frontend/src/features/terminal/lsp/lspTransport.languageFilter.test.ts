import { describe, expect, it } from 'vitest'
import { DevDeckLspTransport, serverLanguage } from './lspTransport'

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

function goTransport() {
  const socket = new FakeSocket()
  const transport = new DevDeckLspTransport(socket as unknown as WebSocket, 'go')
  socket.open()
  return { socket, transport }
}

function sentMethods(socket: FakeSocket) {
  return socket.sent.map((raw) => (JSON.parse(raw) as { method?: string }).method)
}

describe('serverLanguage', () => {
  it('collapses every JS/TS variant to one server language', () => {
    expect(serverLanguage('typescript')).toBe('typescript')
    expect(serverLanguage('typescriptreact')).toBe('typescript')
    expect(serverLanguage('javascript')).toBe('typescript')
    expect(serverLanguage('javascriptreact')).toBe('typescript')
  })

  it('passes every other language id through unchanged', () => {
    expect(serverLanguage('go')).toBe('go')
    expect(serverLanguage('python')).toBe('python')
  })
})

describe('DevDeckLspTransport language filtering', () => {
  it('forwards didOpen for the transport\'s own language', () => {
    const { socket, transport } = goTransport()
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: 'inmemory://devdeck/a', languageId: 'go', version: 1, text: '' } },
    })
    expect(sentMethods(socket)).toEqual(['textDocument/didOpen'])
  })

  it('drops didOpen for a document in a different language', () => {
    const { socket, transport } = goTransport()
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: 'inmemory://devdeck/b', languageId: 'typescript', version: 1, text: '' } },
    })
    expect(socket.sent).toEqual([])
  })

  it('keeps dropping didChange/didClose for a uri it dropped the didOpen for', () => {
    const { socket, transport } = goTransport()
    const uri = 'inmemory://devdeck/b'
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [] },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    })
    expect(socket.sent).toEqual([])
  })

  it('stops dropping a uri once it is legitimately re-opened for this language', () => {
    const { socket, transport } = goTransport()
    const uri = 'inmemory://devdeck/c'
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'go', version: 1, text: '' } },
    })
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [] },
    })
    expect(sentMethods(socket)).toEqual(['textDocument/didOpen', 'textDocument/didChange'])
  })

  it('collapses javascript/tsx/jsx into the same typescript server language', () => {
    const socket = new FakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket, 'typescript')
    socket.open()
    for (const languageId of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) {
      void transport.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: `inmemory://devdeck/${languageId}`, languageId, version: 1, text: '' } },
      })
    }
    expect(sentMethods(socket)).toEqual([
      'textDocument/didOpen',
      'textDocument/didOpen',
      'textDocument/didOpen',
      'textDocument/didOpen',
    ])
  })

  it('does not filter when constructed without a language', () => {
    const socket = new FakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    socket.open()
    void transport.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: 'inmemory://devdeck/a', languageId: 'typescript', version: 1, text: '' } },
    })
    expect(sentMethods(socket)).toEqual(['textDocument/didOpen'])
  })
})
