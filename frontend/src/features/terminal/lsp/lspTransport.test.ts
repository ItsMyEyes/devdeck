import { describe, expect, it, vi } from 'vitest'
import { DevDeckLspTransport } from './lspTransport'

type Listener = (event: unknown) => void

/** Minimal stand-in for the browser WebSocket the transport is handed. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  closedWith: number | undefined
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  send(message: string) {
    this.sent.push(message)
  }

  close(code?: number) {
    this.closedWith = code
    this.readyState = FakeSocket.CLOSED
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.emit('open', {})
  }

  receive(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function makeTransport() {
  const socket = new FakeSocket()
  const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
  return { socket, transport }
}

describe('DevDeckLspTransport', () => {
  it('queues sends until the socket opens, then flushes in order', () => {
    const { socket, transport } = makeTransport()

    transport.send('first')
    transport.send('second')
    expect(socket.sent).toEqual([])

    socket.open()
    expect(socket.sent).toEqual(['first', 'second'])

    transport.send('third')
    expect(socket.sent).toEqual(['first', 'second', 'third'])
  })

  it('resolves ready with the server-supplied rootUri and never forwards control frames', async () => {
    const { socket, transport } = makeTransport()
    const onMessage = vi.fn()
    transport.onMessage(onMessage)
    socket.open()

    socket.receive({ devdeckLsp: { type: 'installing', message: 'Installing gopls…' } })
    expect(transport.getStatus()).toBe('installing')

    socket.receive({ devdeckLsp: { type: 'ready', rootUri: 'file:///work/repo/' } })

    await expect(transport.ready).resolves.toEqual({ rootUri: 'file:///work/repo' })
    expect(transport.getStatus()).toBe('ready')
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('rejects ready and reports the message on an error control frame', async () => {
    const { socket, transport } = makeTransport()
    socket.open()

    socket.receive({ devdeckLsp: { type: 'error', message: 'gopls is not installed' } })

    await expect(transport.ready).rejects.toThrow('gopls is not installed')
    expect(transport.getStatus()).toBe('error')
    expect(transport.getStatusMessage()).toBe('gopls is not installed')
  })

  it('answers workspace/configuration with one null per requested item', () => {
    const { socket, transport } = makeTransport()
    const onMessage = vi.fn()
    transport.onMessage(onMessage)
    socket.open()

    socket.receive({
      jsonrpc: '2.0',
      id: 0,
      method: 'workspace/configuration',
      params: { items: [{ section: 'gopls' }, { section: 'gopls' }] },
    })

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: [null, null],
    })
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('refuses workspace/applyEdit and answers other requests with null', () => {
    const { socket } = makeTransport()
    socket.open()

    socket.receive({ jsonrpc: '2.0', id: 4, method: 'workspace/applyEdit', params: { edit: {} } })
    socket.receive({ jsonrpc: '2.0', id: 5, method: 'client/registerCapability', params: {} })

    expect(JSON.parse(socket.sent[0] as string).result).toEqual({
      applied: false,
      failureReason: 'Workspace edits are not supported',
    })
    expect(JSON.parse(socket.sent[1] as string).result).toBeNull()
  })

  it('forwards server notifications and responses untouched', () => {
    const { socket, transport } = makeTransport()
    const onMessage = vi.fn()
    transport.onMessage(onMessage)
    socket.open()

    const notification = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.go', diagnostics: [] } }
    const response = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } }
    socket.receive(notification)
    socket.receive(response)

    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(JSON.parse(onMessage.mock.calls[0][0] as string)).toEqual(notification)
    expect(JSON.parse(onMessage.mock.calls[1][0] as string)).toEqual(response)
  })

  it('closes once and drops queued messages', () => {
    const { socket, transport } = makeTransport()
    transport.send('queued')

    transport.close()
    transport.close()

    expect(socket.closedWith).toBe(1000)
    socket.readyState = FakeSocket.OPEN
    transport.send('after close')
    expect(socket.sent).toEqual([])
  })
})
