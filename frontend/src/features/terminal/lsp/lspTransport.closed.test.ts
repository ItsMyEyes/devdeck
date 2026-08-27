import { describe, expect, it, vi } from 'vitest'
import { DevDeckLspTransport, type LspStatus } from './lspTransport'

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

  // Answering `null` keeps monaco unblocked, but it is indistinguishable from
  // "the server looked and found nothing" — so a dead transport that still
  // *reports* itself ready is a language server that has silently stopped
  // working. Two things depend on the status being truthful here:
  //
  //  - `createLspSessionPool` retires a cached session by asking
  //    `getStatus() === 'error'`. A dead-but-'ready' session is never retired,
  //    so every file opened afterwards is handed the same corpse and the
  //    worktree has no language support until the page is reloaded.
  //  - `CodeFileEditor`'s status effect raises the "Language server
  //    unavailable" toast off the same signal, so the operator is never told.
  //
  // Sockets die after `ready` routinely: gopls crashes on a large module, the
  // hub restarts (every `tauri dev` rebuild), the laptop sleeps, a tunnel to a
  // remote machine blips.
  it('reports error once a socket that had reached ready dies', () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const seen: LspStatus[] = []
    transport.onStatus((status) => seen.push(status))
    ready(socket)
    expect(transport.getStatus()).toBe('ready')

    socket.close()

    expect(transport.getStatus()).toBe('error')
    expect(seen).toContain('error')
  })

  // DevDeck closing the transport itself is an orderly teardown (the pool's
  // idle disposal, or the last editor releasing it), not a failure. Reporting
  // 'error' there would fire a toast at an operator who simply closed a file.
  it('stays ready when DevDeck closes the transport deliberately', () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)

    transport.close()

    expect(transport.getStatus()).toBe('ready')
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
