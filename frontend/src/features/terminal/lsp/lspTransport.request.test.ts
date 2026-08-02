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

describe('DevDeckLspTransport.request', () => {
  it('sends a request with a devdeck-prefixed id', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    void transport.request('textDocument/rename', { newName: 'x' })
    const message = JSON.parse(socket.sent.at(-1) as string)
    expect(String(message.id).startsWith('devdeck-')).toBe(true)
    expect(message.method).toBe('textDocument/rename')
  })

  it('resolves with the result and never forwards it to the client listener', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)

    const pending = transport.request<{ ok: boolean }>('textDocument/rename', {})
    const id = JSON.parse(socket.sent.at(-1) as string).id
    socket.emit({ jsonrpc: '2.0', id, result: { ok: true } })

    await expect(pending).resolves.toEqual({ ok: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects when the server returns an error', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    const pending = transport.request('textDocument/rename', {})
    const id = JSON.parse(socket.sent.at(-1) as string).id
    socket.emit({ jsonrpc: '2.0', id, error: { code: -32600, message: 'nope' } })
    await expect(pending).rejects.toThrow('nope')
  })

  it('forwards responses that are not ours to the client listener', () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)
    socket.emit({ jsonrpc: '2.0', id: 7, result: { fromMonaco: true } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects everything still pending when the socket closes', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    const pending = transport.request('textDocument/rename', {})
    socket.close()
    await expect(pending).rejects.toThrow()
  })
})
