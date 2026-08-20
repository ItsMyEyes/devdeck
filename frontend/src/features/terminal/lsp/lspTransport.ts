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

/** Several Monaco language ids share one server process (typescript-language-
 *  server speaks for all four JS/TS variants), so both the session pool and
 *  this transport's outbound language filter (below) key on the collapsed
 *  name rather than the raw language id. Lives here, not in `lspSession.ts`,
 *  so `lspTransport.ts` doesn't have to import back from its own consumer. */
export function serverLanguage(languageId: string) {
  if (
    languageId === 'typescript' ||
    languageId === 'typescriptreact' ||
    languageId === 'javascript' ||
    languageId === 'javascriptreact'
  ) {
    return 'typescript'
  }
  return languageId
}

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

/**
 * Recovers a document uri's real capitalisation by matching it, case
 * insensitively, against the uris of the models currently open in the editor.
 *
 * `MonacoLspClient`'s `ManagedModel` lowercases every uri it puts on the wire:
 *
 *     const uri = _textModel.uri.toString(true).toLowerCase();
 *     this._api.textDocumentDidOpen({ textDocument: { ..., uri } })
 *
 * It does that because its own reverse lookup table is keyed the same way, so
 * inbound uris survive a case-insensitive filesystem. But the *outbound* uri is
 * the one the language server has to place inside the workspace, and servers
 * compare it byte for byte against the paths their build system reports. On
 * macOS `/Users/me/Documents/app` arrives as `/users/me/documents/app`, which
 * gopls answers with "This file is within module …, which is not included in
 * your workspace" and then type-checks the file on its own — every symbol
 * defined in a sibling file reads as `undefined`. Nothing else looks wrong: the
 * file opens, the code is valid, and the server never reports an error.
 *
 * Returns `uri` unchanged when no open model matches (an `inmemory://` buffer,
 * or a model already gone), which is exactly today's behaviour for those.
 */
export function restoreDocumentUriCase(uri: string, knownUris: Iterable<string>): string {
  const lowered = uri.toLowerCase()
  for (const known of knownUris) {
    if (known.toLowerCase() === lowered) return known
  }
  return uri
}

/**
 * True for a document-synchronisation notification naming a uri no language
 * server can address.
 *
 * Every uri DevDeck puts on the wire is a `file://` one, built by `uriHelpers`
 * from the worktree root the backend reports. But `MonacoLspClient`'s
 * `TextDocumentSynchronizer` announces *every* model monaco holds, and
 * `MonacoEditor` deliberately builds each code model on a synthetic
 * `inmemory://devdeck/…` uri first, swapping to the real one only once the LSP
 * session has resolved (see its `uri` prop doc) — so those placeholder buffers
 * were announced too, along with every non-LSP surface's scratch model.
 *
 * gopls answers a non-file uri with a hard `-32700 "DocumentURI scheme is not
 * 'file'"`, and returns the same for the `textDocument/semanticTokens/full`
 * monaco fires against that placeholder model a moment later. Monaco files a
 * semantic-tokens error under "temporarily unavailable" and schedules no retry
 * (`ModelSemanticColoring`), so a doomed exchange costs real colour rather than
 * just noise — `rangeSemanticTokens.ts` covers the other way a file loses its
 * whole-file token set.
 *
 * Only the three fire-and-forget notifications are filtered. A *request*
 * carries an id and someone waiting on it, so dropping one would hang the
 * caller — the exact failure `answerWithoutServer` exists to prevent.
 */
function isUnaddressableDocumentMessage(message: RpcMessage): boolean {
  if (
    message.method !== 'textDocument/didOpen' &&
    message.method !== 'textDocument/didChange' &&
    message.method !== 'textDocument/didClose'
  ) {
    return false
  }
  const uri = (message.params as { textDocument?: { uri?: string } } | undefined)?.textDocument?.uri
  return uri !== undefined && !uri.startsWith('file://')
}

/**
 * Settings a language server needs before it will offer something DevDeck
 * relies on, keyed by `serverLanguage()`.
 *
 * gopls gates semantic tokens behind an experimental option that is *off* by
 * default (`gopls api-json` reports `semanticTokens` default `false`, status
 * `experimental`, as of v0.22). Left at the default it answers `initialize`
 * with no `semanticTokensProvider` at all, so monaco never registers a
 * semantic-tokens provider and every identifier is painted by the monarch
 * grammar alone — which knows keywords and strings but cannot tell a function
 * from a variable. That is why `func main()` and `cli.ExecuteRootCmd()` render
 * in the plain foreground instead of the function colour.
 *
 * Nothing here overrides a user's own gopls configuration file; these are the
 * settings the *client* asks for, which is exactly where VS Code puts the same
 * flag.
 */
const SERVER_SETTINGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  go: { semanticTokens: true },
}

/** The `workspace/configuration` section a server pulls its settings from —
 *  gopls asks for `"gopls"` (verified against gopls v0.22 over a real stdio
 *  session), not for its monaco language id. */
const SETTINGS_SECTION: Readonly<Record<string, string>> = {
  go: 'gopls',
}

export function serverSettings(language: string | undefined): Record<string, unknown> | undefined {
  if (!language) return undefined
  return SERVER_SETTINGS[serverLanguage(language)] as Record<string, unknown> | undefined
}

/**
 * This client's answer to one `workspace/configuration` item.
 *
 * A server reads its settings twice — once from `initializationOptions` while
 * it boots, then again from this request — and the second read *replaces* the
 * first. Answering `null` for every item (which this transport used to do)
 * therefore handed back whatever `rewriteInitialize` had just asked for, so the
 * setting had to be repeated here for it to survive.
 *
 * An item with no `section` asks for the whole configuration tree, so the
 * settings are returned nested under their section name; a request for some
 * other server's section still gets `null`.
 */
export function configurationItemResult(language: string | undefined, section: unknown): unknown {
  const settings = serverSettings(language)
  if (!settings || !language) return null
  const own = SETTINGS_SECTION[serverLanguage(language)]
  if (section === undefined || section === null || section === '') {
    return own ? { [own]: settings } : settings
  }
  return section === own ? settings : null
}

/** MonacoLspClient hardcodes `rootUri: null` and sends no workspaceFolders,
 *  which drops gopls into single-file mode. The backend already told us the
 *  real root in its `ready` control frame, so patch it in transit rather than
 *  patching or subclassing the client. The same rewrite carries
 *  `initializationOptions` (see `SERVER_SETTINGS`), which the client has no way
 *  to supply either. Every other message passes through by reference,
 *  untouched. */
export function rewriteInitialize(
  message: RpcMessage,
  rootUri: string,
  language?: string,
): RpcMessage {
  if (message.method !== 'initialize') return message
  const params = message.params as Record<string, unknown> | undefined
  const settings = serverSettings(language)
  return {
    ...message,
    params: {
      ...params,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
      // Merged, not replaced: the client sends none today, but a future monaco
      // that starts populating this must not have its options dropped.
      ...(settings
        ? {
            initializationOptions: {
              ...(params?.initializationOptions as Record<string, unknown> | undefined),
              ...settings,
            },
          }
        : {}),
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
 * 5. `MonacoLspClient`'s `TextDocumentSynchronizer` watches monaco's *global*
 *    model list (`editor.getModels()` / `onDidCreateModel`), not just the
 *    models for its own server's language — so with one `MonacoLspClient` per
 *    language sharing the same tab, a Go client and a TypeScript client each
 *    see every open model of every language. Outbound `textDocument/didOpen`
 *    (and the `didChange`/`didClose` that follow it for the same uri) are
 *    dropped here when they're for a document this transport's own language
 *    doesn't own, so a gopls process behind this transport never hears about
 *    a `.ts` buffer and vice versa.
 *
 * 6. `MonacoLspClient` also lowercases every outbound document uri, which stops
 *    a server placing the file inside the workspace on any path that isn't
 *    already lowercase. The real capitalisation is restored in transit — see
 *    `restoreDocumentUriCase`.
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
  private readonly language: string | undefined
  private readonly knownDocumentUris: (() => Iterable<string>) | undefined
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
  /** Uris this transport has seen a foreign-language `didOpen` for, so the
   *  `didChange`/`didClose` that follow it (which carry no `languageId` of
   *  their own) are dropped too, until the uri closes. */
  private readonly foreignUris = new Set<string>()
  /** Lowercased uri → the real-case uri the document was opened under. The
   *  `didChange`/`didClose` for a document must address it exactly as its
   *  `didOpen` did, and by `didClose` time the model is already leaving
   *  monaco's list (`onWillDispose` fires *during* disposal), so the mapping
   *  cannot be re-derived then — it has to be remembered from the open. */
  private readonly openedUris = new Map<string, string>()

  /** `language` is the collapsed server language this transport's socket was
   *  opened for (see `serverLanguage`) — optional so every existing direct
   *  construction (this file's own tests, and any future caller with no
   *  language filtering to do) keeps working unfiltered. `knownDocumentUris`
   *  lists the uris of the editor's open models, real capitalisation intact;
   *  it is a callback rather than a value so this module stays free of monaco
   *  (see `IMessageTransport` above), and omitting it disables the case repair
   *  in `restoreDocumentUriCase`. */
  constructor(socket: WebSocket, language?: string, knownDocumentUris?: () => Iterable<string>) {
    this.socket = socket
    this.language = language
    this.knownDocumentUris = knownDocumentUris
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
    if (this.unusable) {
      this.answerWithoutServer(message)
      return Promise.resolve()
    }
    // Case repair runs first so the language filter below, which keys on the
    // uri, tracks the same string the wire carries.
    if (typeof message !== 'string') message = this.withRealDocumentUri(message as RpcMessage)
    if (
      typeof message !== 'string' &&
      (this.isForeignDocumentMessage(message as RpcMessage) ||
        isUnaddressableDocumentMessage(message as RpcMessage))
    ) {
      return Promise.resolve()
    }
    const payload =
      typeof message === 'string'
        ? message
        : JSON.stringify(rewriteInitialize(message as RpcMessage, this.rootUri ?? '', this.language))
    if (this.socket.readyState !== 1) {
      this.queue.push(payload)
    } else {
      this.socket.send(payload)
    }
    return Promise.resolve()
  }

  /** True once the socket can no longer carry anything — whether DevDeck closed
   *  it (`close()`) or the peer did (`readyState` 2/3 are CLOSING/CLOSED). The
   *  peer's own close never sets `closed`, so checking that flag alone left a
   *  server-side shutdown queueing messages into a socket that would never
   *  drain. */
  private get unusable(): boolean {
    return this.closed || this.socket.readyState >= 2
  }

  /**
   * Answers a request that can no longer reach the server, so its caller
   * settles instead of waiting forever.
   *
   * `MonacoLspClient` registers ~22 monaco providers in its constructor and
   * offers no way to take them back — `createFeatures()` collects them into a
   * `DisposableStore` the constructor then discards — and it never looks at
   * `IMessageTransport.state`. A client whose session has been disposed
   * therefore keeps serving monaco for the lifetime of the page. Monaco's
   * `getLocationLinks` awaits `Promise.all` over *every* registered provider,
   * so a single request that never settles silently disables go-to-definition
   * (hover, completion, references — all of them aggregate the same way), even
   * though a healthy client is registered right next to the dead one. That is
   * what "open a .go file, close it, open another" used to do.
   *
   * A null result is the graceful answer rather than an error: every provider
   * request LSP defines accepts `null` as "nothing found", so monaco merges the
   * live client's answer and logs nothing. Notifications carry no id, so there
   * is nothing to answer and nobody waiting — they stay dropped.
   *
   * Delivery is deferred to a microtask so the caller has finished registering
   * its pending request before the response arrives.
   */
  private answerWithoutServer(message: unknown) {
    let parsed: RpcMessage | undefined
    if (typeof message === 'string') {
      try {
        parsed = JSON.parse(message) as RpcMessage
      } catch {
        return
      }
    } else {
      parsed = message as RpcMessage | undefined
    }
    const id = parsed?.id
    if (!parsed || typeof parsed.method !== 'string' || id === undefined || id === null) return

    const response: RpcMessage = { jsonrpc: '2.0', id, result: null }
    queueMicrotask(() => {
      // `devdeck-` ids belong to this transport's own `request()` channel and
      // are resolved there; anything else is the client's and goes to its
      // listener, exactly as a real response would (see `handleMessage`).
      if (this.resolvePending(response)) return
      this.listener?.(response)
    })
  }

  /** Returns `message` with its document uri restored to the capitalisation
   *  the model really has — see `restoreDocumentUriCase` for why the uri
   *  arrives lowercased and what it costs. Only the three synchronisation
   *  notifications are touched; every request DevDeck issues itself already
   *  addresses documents by `documentUri()`, which is correct by construction.
   *  A copy is returned rather than a mutation, matching `rewriteInitialize` —
   *  the message object belongs to `MonacoLspClient`. */
  private withRealDocumentUri(message: RpcMessage): RpcMessage {
    const method = message.method
    if (
      method !== 'textDocument/didOpen' &&
      method !== 'textDocument/didChange' &&
      method !== 'textDocument/didClose'
    ) {
      return message
    }

    const params = message.params as
      | { textDocument?: { uri?: string } & Record<string, unknown> }
      | undefined
    const uri = params?.textDocument?.uri
    if (!uri) return message

    const key = uri.toLowerCase()
    let real: string
    if (method === 'textDocument/didOpen') {
      real = this.knownDocumentUris
        ? restoreDocumentUriCase(uri, this.knownDocumentUris())
        : uri
      if (real !== uri) this.openedUris.set(key, real)
      else this.openedUris.delete(key)
    } else {
      real = this.openedUris.get(key) ?? uri
      if (method === 'textDocument/didClose') this.openedUris.delete(key)
    }
    if (real === uri) return message

    return {
      ...message,
      params: {
        ...params,
        textDocument: { ...params?.textDocument, uri: real },
      },
    }
  }

  /** True for a `textDocument/didOpen`, `didChange` or `didClose` that
   *  belongs to a document outside this transport's own language — see point
   *  5 in the class doc comment. Tracks the offending uris across the three
   *  notification types since only `didOpen` carries a `languageId`. */
  private isForeignDocumentMessage(message: RpcMessage): boolean {
    if (this.language === undefined) return false
    const params = message.params as { textDocument?: { uri?: string; languageId?: string } } | undefined
    const uri = params?.textDocument?.uri

    if (message.method === 'textDocument/didOpen') {
      const languageId = params?.textDocument?.languageId
      const foreign = languageId !== undefined && serverLanguage(languageId) !== this.language
      if (uri) {
        if (foreign) this.foreignUris.add(uri)
        else this.foreignUris.delete(uri)
      }
      return foreign
    }

    if (message.method === 'textDocument/didChange' || message.method === 'textDocument/didClose') {
      if (uri && this.foreignUris.has(uri)) {
        if (message.method === 'textDocument/didClose') this.foreignUris.delete(uri)
        return true
      }
    }

    return false
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
      const items = (message.params as { items?: { section?: unknown }[] } | undefined)?.items
      result = Array.isArray(items)
        ? items.map((item) => configurationItemResult(this.language, item?.section))
        : []
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

export async function openLspTransport(
  machine: Machine,
  worktreeId: string,
  language: string,
  knownDocumentUris?: () => Iterable<string>,
) {
  const url = await machineWsUrl(machine, '/lsp', { worktree: worktreeId, language })
  return new DevDeckLspTransport(new WebSocket(url), language, knownDocumentUris)
}
