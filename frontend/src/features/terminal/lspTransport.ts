import type { Transport } from 'codemirror-languageserver'
import { machineWsUrl } from '@/lib/machineClient'
import type { Machine } from '@/store/types'

export type LspStatus = 'connecting' | 'installing' | 'ready' | 'error'

export type LspStatusListener = (status: LspStatus, message?: string) => void

interface ControlFrame {
  type: 'ready' | 'error' | 'installing'
  message?: string
  language?: string
  rootUri?: string
}

interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: unknown
  devdeckLsp?: ControlFrame
}

const CLOSED_MESSAGE = 'Language server connection closed'

/**
 * A `codemirror-languageserver` Transport over DevDeck's authenticated
 * `/ws/lsp` socket. It differs from the package's own `WebSocketTransport` in
 * three ways, each of which the backend or the package forces on us:
 *
 * 1. The backend prefixes the JSON-RPC stream with `devdeckLsp` control frames
 *    (installing / ready+rootUri / error). Those are consumed here and turned
 *    into status events; they never reach the RPC layer.
 * 2. The package's JSONRPCClient only waits for the socket's `open` event when
 *    the transport is `instanceof WebSocketTransport`. For anything else its
 *    internal ready promise resolves immediately, so sends must be queued here
 *    or they throw InvalidStateError.
 * 3. `LanguageServerClient` answers every server request with `{result: null}`,
 *    which is the wrong shape for `workspace/configuration` and misses `id: 0`
 *    entirely. Requests are answered here and not forwarded, so the package's
 *    blanket reply never runs.
 */
export class DevDeckLspTransport implements Transport {
  readonly ready: Promise<{ rootUri: string }>

  private readonly socket: WebSocket
  private readonly messageListeners = new Set<(message: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly statusListeners = new Set<LspStatusListener>()
  private readonly queue: string[] = []
  private status: LspStatus = 'connecting'
  private statusMessage: string | undefined
  private closed = false
  private resolveReady!: (value: { rootUri: string }) => void
  private rejectReady!: (reason: Error) => void

  constructor(socket: WebSocket) {
    this.socket = socket
    this.ready = new Promise<{ rootUri: string }>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // The pool surfaces failures through its own rejection, so nothing may be
    // awaiting `ready` when it rejects. Pre-attach a catch so that never
    // becomes an unhandled rejection.
    this.ready.catch(() => undefined)

    socket.addEventListener('open', () => this.flush())
    socket.addEventListener('message', (event) => this.handleMessage(event as MessageEvent))
    socket.addEventListener('close', () => this.handleClose())
    socket.addEventListener('error', () => this.handleError())

    if (socket.readyState === 1) this.flush()
  }

  send(message: string) {
    if (this.closed) return
    if (this.socket.readyState !== 1) {
      this.queue.push(message)
      return
    }
    this.socket.send(message)
  }

  onMessage(callback: (message: string) => void) {
    this.messageListeners.add(callback)
  }

  onClose(callback: () => void) {
    this.closeListeners.add(callback)
  }

  onError(callback: (error: Error) => void) {
    this.errorListeners.add(callback)
  }

  onStatus(listener: LspStatusListener) {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  getStatus() {
    return this.status
  }

  getStatusMessage() {
    return this.statusMessage
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    if (this.socket.readyState < 2) this.socket.close(1000)
  }

  private flush() {
    while (this.queue.length > 0 && this.socket.readyState === 1) {
      this.socket.send(this.queue.shift() as string)
    }
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== 'string') return
    let message: RpcMessage
    try {
      message = JSON.parse(event.data) as RpcMessage
    } catch {
      return
    }

    if (message.devdeckLsp) {
      this.handleControl(message.devdeckLsp)
      return
    }
    // A server-to-client *request* carries both a method and an id. `id: 0` is
    // a legal id, so the check must be against undefined/null, not falsiness.
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      this.respond(message)
      return
    }
    for (const listener of this.messageListeners) listener(event.data)
  }

  private handleControl(frame: ControlFrame) {
    if (frame.type === 'installing') {
      this.setStatus('installing', frame.message)
      return
    }
    if (frame.type === 'ready' && frame.rootUri) {
      this.setStatus('ready')
      this.resolveReady({ rootUri: frame.rootUri.replace(/\/+$/, '') })
      return
    }
    const message = frame.message ?? 'Language server unavailable'
    this.setStatus('error', message)
    this.rejectReady(new Error(message))
  }

  private respond(message: RpcMessage) {
    let result: unknown = null
    if (message.method === 'workspace/configuration') {
      const items = (message.params as { items?: unknown[] } | undefined)?.items
      result = Array.isArray(items) ? items.map(() => null) : []
    } else if (message.method === 'workspace/applyEdit') {
      result = { applied: false, failureReason: 'Workspace edits are not supported' }
    }
    this.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }

  private handleClose() {
    if (this.status !== 'ready') {
      const message = this.statusMessage ?? CLOSED_MESSAGE
      this.setStatus('error', message)
      this.rejectReady(new Error(message))
    }
    for (const listener of this.closeListeners) listener()
  }

  private handleError() {
    const error = new Error('Could not connect to the language server')
    if (this.status !== 'ready') {
      this.setStatus('error', error.message)
      this.rejectReady(error)
    }
    for (const listener of this.errorListeners) listener(error)
  }

  private setStatus(status: LspStatus, message?: string) {
    if (this.status === status && this.statusMessage === message) return
    this.status = status
    this.statusMessage = message
    for (const listener of this.statusListeners) listener(status, message)
  }
}

export async function openLspTransport(machine: Machine, worktreeId: string, language: string) {
  const url = await machineWsUrl(machine, '/lsp', { worktree: worktreeId, language })
  return new DevDeckLspTransport(new WebSocket(url))
}
