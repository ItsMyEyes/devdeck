import { describe, expect, it, vi } from 'vitest'
import { DevDeckLspTransport } from './lspTransport'

/** Minimal WebSocket stand-in: records what was sent and lets a test push
 *  frames back. Mirrors the fake in lspTransport.test.ts. */
function fakeSocket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const sent: string[] = []
  return {
    readyState: 1,
    sent,
    addEventListener(type: string, handler: (event: unknown) => void) {
      const bucket = listeners.get(type) ?? []
      bucket.push(handler)
      listeners.set(type, bucket)
    },
    send(data: string) {
      sent.push(data)
    },
    close() {
      this.readyState = 3
      for (const handler of listeners.get('close') ?? []) handler({})
    },
    emit(data: unknown) {
      for (const handler of listeners.get('message') ?? []) handler({ data: JSON.stringify(data) })
    },
  }
}

function ready(socket: ReturnType<typeof fakeSocket>) {
  socket.emit({ devdeckLsp: { type: 'ready', rootUri: 'file:///root' } })
}

// `MonacoLspClient` registers ~22 monaco providers in its constructor and
// exposes no way to unregister them (its `createFeatures()` builds a
// DisposableStore and throws it away), and it never looks at the transport's
// `state`. So a client whose session has been disposed keeps answering monaco
// forever. Monaco's own `getLocationLinks` awaits `Promise.all` over every
// registered provider, so one request that never settles silently kills
// go-to-definition — including for the *live* client alongside it.
//
// The transport is the only layer that knows the socket is gone, so a dead one
// answers instead of swallowing: every request settles, and monaco merges the
// live provider's result as if the dead one had simply found nothing.
describe('DevDeckLspTransport after the socket is gone', () => {
  it('answers a client request the peer closed on, rather than leaving it pending', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)
    socket.close()

    void transport.send({ jsonrpc: '2.0', id: 7, method: 'textDocument/definition', params: {} })
    await Promise.resolve()

    expect(listener).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 7, result: null })
  })

  it('answers after DevDeck closes the transport itself', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)
    transport.close()

    void transport.send({ jsonrpc: '2.0', id: 'abc', method: 'textDocument/hover', params: {} })
    await Promise.resolve()

    expect(listener).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 'abc', result: null })
  })

  // A notification has no id, so there is nothing to answer — and no caller
  // waiting on one either. Feeding a bogus response back for `didChange` would
  // just confuse the client's own bookkeeping.
  it('stays silent for a notification', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)
    transport.close()

    void transport.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {} })
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('settles DevDeck’s own requests instead of hanging them', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    transport.close()

    await expect(transport.request('textDocument/definition', {})).resolves.toBeNull()
  })

  it('still sends normally while the socket is open', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)

    void transport.send({ jsonrpc: '2.0', id: 1, method: 'textDocument/definition', params: {} })
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(socket.sent.some((raw) => JSON.parse(raw).method === 'textDocument/definition')).toBe(true)
  })
})
