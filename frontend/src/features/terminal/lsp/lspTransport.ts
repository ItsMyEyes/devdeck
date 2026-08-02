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
  jsonrpc?: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  devdeckLsp?: ControlFrame
}

const CLOSED_MESSAGE = 'Language server connection closed'

/** Structural copy of monaco's `lsp.IMessageTransport`. Declared locally rather
 *  than imported so this module — and its tests — stay free of monaco, which
 *  needs a real browser. `monacoLspClient.guard.test.ts` pins the alias itself;
 *  a mismatch here surfaces as a typecheck error at the construction site. */
interface IValueWithChangeEvent<T> {
  readonly value: T
  onChange(listener: (value: T) => void): { dispose(): void }
}
type ConnectionState =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error: Error | undefined }
interface IMessageTransport {
  readonly state: IValueWithChangeEvent<ConnectionState>
  send(message: unknown): Promise<void>
  setListener(listener: ((message: unknown) => void) | undefined): void
  toString(): string
}

/** Minimal `IValueWithChangeEvent` implementation backing `state`. */
class MutableValue<T> implements IValueWithChangeEvent<T> {
  private current: T
  private readonly listeners = new Set<(value: T) => void>()

  constructor(initial: T) {
    this.current = initial
  }

  get value(): T {
    return this.current
  }

  set(next: T) {
    this.current = next
    for (const listener of this.listeners) listener(next)
  }

  onChange(listener: (value: T) => void) {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
}

/** MonacoLspClient hardcodes `rootUri: null` and sends no workspaceFolders,
 *  which drops gopls into single-file mode. The backend already told us the
 *  real root in its `ready` control frame, so patch it in transit rather than
 *  patching or subclassing the client. Every other message passes through by
 *  reference, untouched. */
export function rewriteInitialize(message: RpcMessage, rootUri: string): RpcMessage {
  if (message.method !== 'initialize') return message
  return {
    ...message,
    params: {
      ...(message.params as Record<string, unknown> | undefined),
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
    },
  }
}

/**
 * DevDeck's authenticated `/ws/lsp` socket, adapted to monaco's native
 * `lsp.IMessageTransport`. It differs from a bare WebSocket transport in four
 * ways, each of which the backend or `MonacoLspClient` forces on us:
 *
 * 1. The backend prefixes the JSON-RPC stream with `devdeckLsp` control frames
 *    (installing / ready+rootUri / error). Those are consumed here and turned
 *    into status events; they never reach the RPC layer.
 * 2. Sends must be queued here until `socket.readyState === OPEN` or they
 *    throw InvalidStateError — neither monaco's client nor a raw WebSocket
 *    does this for us.
 * 3. A server-to-client *request* (`workspace/configuration`,
 *    `workspace/applyEdit`) needs a correctly shaped reply, including the
 *    legal-but-falsy `id: 0`. Requests are answered here and never forwarded.
 * 4. `MonacoLspClient` sends `rootUri: null` with no `workspaceFolders`; the
 *    outbound `initialize` is rewritten in transit via `rewriteInitialize`.
 *
 * It also exposes a private `request()` channel on `devdeck-`-prefixed string
 * ids, alongside the numeric ids `MonacoLspClient` allocates, so DevDeck can
 * drive cross-file rename and other flows the client itself doesn't support.
 *
 * `onMessage`/`onClose`/`onError` and the string overload of `send` are kept
 * alongside the new `setListener`/`state` members because `lspSession.ts`
 * still wraps this transport for `codemirror-languageserver`'s
 * `LanguageServerClient`, which requires that exact shape, until Task 6 swaps
 * it for `MonacoLspClient`.
 */
export class DevDeckLspTransport implements IMessageTransport {
  readonly ready: Promise<{ rootUri: string }>
  readonly state = new MutableValue<ConnectionState>({ state: 'connecting' })

  private readonly socket: WebSocket
  private readonly messageListeners = new Set<(message: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly statusListeners = new Set<LspStatusListener>()
  private listener: ((message: unknown) => void) | undefined
  private readonly queue: string[] = []
  private status: LspStatus = 'connecting'
  private statusMessage: string | undefined
  private closed = false
  private resolveReady!: (value: { rootUri: string }) => void
  private rejectReady!: (reason: Error) => void
  private rootUri: string | undefined
  private readonly pending = new Map<
    string,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >()
  private nextRequestId = 0

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

    socket.addEventListener('open', () => {
      this.state.set({ state: 'open' })
      this.flush()
    })
    socket.addEventListener('message', (event) => this.handleMessage(event as MessageEvent))
    socket.addEventListener('close', () => this.handleClose())
    socket.addEventListener('error', () => this.handleError())

    if (socket.readyState === 1) {
      this.state.set({ state: 'open' })
      this.flush()
    }
  }

  /** Accepts either a raw JSON string (the legacy `codemirror-languageserver`
   *  shape `lspSession.ts` still sends) or a JSON-RPC message object (monaco's
   *  `IMessageTransport.send`, and this transport's own `request()`). Objects
   *  run through `rewriteInitialize` and are stringified before queueing;
   *  strings pass through unchanged. */
  send(message: unknown): Promise<void> {
    if (this.closed) return Promise.resolve()
    const payload =
      typeof message === 'string'
        ? message
        : JSON.stringify(rewriteInitialize(message as RpcMessage, this.rootUri ?? ''))
    if (this.socket.readyState !== 1) {
      this.queue.push(payload)
    } else {
      this.socket.send(payload)
    }
    return Promise.resolve()
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

  /** monaco's single-slot listener registration. A previous listener, if any,
   *  is replaced — `MonacoLspClient` sets exactly one, and keeping a set would
   *  silently double-deliver. */
  setListener(listener: ((message: unknown) => void) | undefined) {
    this.listener = listener
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

  /** A second JSON-RPC caller on the same socket, alongside MonacoLspClient.
   *  Ids are strings prefixed `devdeck-`, so they cannot collide with the
   *  numeric ids the client allocates; responses carrying one are resolved
   *  here and never forwarded. This is how DevDeck drives cross-file rename,
   *  which the client's own rename feature cannot do (it applies edits only
   *  to models that are already loaded). */
  request<T>(method: string, params: unknown): Promise<T> {
    const id = `devdeck-${this.nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
      })
      void this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  toString() {
    return 'DevDeckLspTransport'
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.rejectAllPending(new Error(CLOSED_MESSAGE))
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

    if (this.resolvePending(message)) return

    // A server-to-client *request* carries both a method and an id. `id: 0` is
    // a legal id, so the check must be against undefined/null, not falsiness.
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      this.respond(message)
      return
    }

    for (const listener of this.messageListeners) listener(event.data)
    this.listener?.(message)
  }

  /** Resolves a response to `request()`. Returns true (and consumes the
   *  message) only for ids this transport itself allocated, so a message with
   *  a foreign, numeric id — one of MonacoLspClient's own requests — always
   *  falls through to the forwarding path below. */
  private resolvePending(message: RpcMessage): boolean {
    const id = message.id
    if (typeof id !== 'string' || !id.startsWith('devdeck-')) return false
    if (message.result === undefined && message.error === undefined) return false
    const entry = this.pending.get(id)
    if (entry) {
      this.pending.delete(id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result as never)
    }
    return true
  }

  private rejectAllPending(error: Error) {
    if (this.pending.size === 0) return
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  private handleControl(frame: ControlFrame) {
    if (frame.type === 'installing') {
      this.setStatus('installing', frame.message)
      return
    }
    if (frame.type === 'ready' && frame.rootUri) {
      const rootUri = frame.rootUri.replace(/\/+$/, '')
      this.rootUri = rootUri
      this.setStatus('ready')
      this.resolveReady({ rootUri })
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
    this.state.set({ state: 'closed', error: undefined })
    this.rejectAllPending(new Error(this.statusMessage ?? CLOSED_MESSAGE))
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
