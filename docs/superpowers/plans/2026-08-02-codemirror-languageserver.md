# CodeMirror Language Server Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DevDeck's hand-rolled 592-line LSP client with `codemirror-languageserver@1.22.0`, adding hover documentation, document highlight, formatting, and cross-file rename to the worktree code editor.

**Architecture:** A DevDeck-owned `Transport` rides the existing authenticated `/ws/lsp` socket, demultiplexing the `devdeckLsp` control frames and answering server→client requests. A ref-counted session pool wraps the package's `LanguageServerClient`. A separate extensions module assembles the package's aggregate extension and overrides three of its bundled behaviours at `Prec.high` (Ctrl-click navigation, autocomplete fallback, diagnostics). Cross-file rename is entirely DevDeck's: pure `WorkspaceEdit` splitting plus a confirmation dialog that writes other files through the worktree file API.

**Tech Stack:** React 19, TypeScript 5.7 (`verbatimModuleSyntax`), Vite 8, CodeMirror 6, `codemirror-languageserver@1.22.0`, `vscode-languageserver-protocol@^3.17.5`, TanStack Query, zustand 5, Vitest 4 (jsdom), sonner, lucide-react.

**Spec:** `docs/superpowers/specs/2026-08-02-codemirror-languageserver-design.md`

## Global Constraints

- Imports from `src/` MUST use the `@/*` alias. Never relative paths into `src/`. Sibling files inside `src/features/terminal/` use `./name` as the existing files already do.
- `verbatimModuleSyntax` is on — type-only imports MUST use `import type`.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- Icons: `lucide-react` only. Toasts: `toast()` from `sonner` (this is what `CodeFileEditor.tsx` and `FileEditor.tsx` already use). Class merging: `cn()` from `@/lib/utils`.
- Design is dark-only; use the existing `devdeck-*` CSS custom properties and the `devdeckCodeTheme` tokens.
- `frontend/src/store/useDevDeckStore.ts`, `frontend/src/store/types.ts`, and `backend/*` are NOT touched by any task in this plan.
- Verification gates for every task: `npm run typecheck` and `npm test`, both run from `frontend/`. The one exception is Task 3, which knowingly leaves `CodeFileEditor.tsx` broken until Task 7; that step says so explicitly. No other task may leave the tree red.
- Package version is pinned exactly: `codemirror-languageserver@1.22.0`. Do not use `^`.
- No backend changes. `backend/internal/lsp/server.go` already provides everything needed.
- Every new `.test.ts` file MUST be added to the `test.include` array in `frontend/vite.config.ts`, or it will never run.

## Background: what the package does and does not do

Read this before Task 2. All four facts were verified against the published `dist/index.js`.

1. `Transport` is `{ send, onMessage, onClose, onError, close }`. Custom transports are fully supported.
2. `LanguageServerClient` answers every server→client request with `{ result: null }`, gated on `data.method && data.id`. That is wrong for `workspace/configuration` (which must return an array with one entry per requested item) and skips request `id: 0` entirely. Our transport intercepts these first and does not forward them, so the package's blanket reply never fires.
3. `LanguageServerPlugin.requestLocation` computes `{ uri, range }` for definitions in **any** file but only moves the selection when `uri === documentUri`; the exported `jumpToDefinition` command throws the return value away. Cross-file navigation must be ours.
4. `applyWorkspaceEdit` reads only `edit.changes[plugin.documentUri]` and skips `documentChanges` entries for other files. Cross-file rename must be ours.

Additional constraint discovered while planning: `JSONRPCClient` only waits for the socket's `open` event when the transport is `instanceof WebSocketTransport`. For a custom transport its internal ready promise resolves immediately, so **the transport itself must queue sends until the socket is open**.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/src/features/terminal/lspTransport.ts` | `Transport` over `/ws/lsp`: control-frame demux, send queue, server-request replies, status events |
| `frontend/src/features/terminal/lspTransport.test.ts` | Transport tests against a fake socket |
| `frontend/src/features/terminal/lspClient.ts` | Rewritten: `LspSession`, uri↔path mapping, ref-counted pool |
| `frontend/src/features/terminal/lspClient.test.ts` | Rewritten: pool refcounting, uri↔path round-trip |
| `frontend/src/features/terminal/lspWorkspaceEdit.ts` | Pure `WorkspaceEdit` splitting and text-edit application |
| `frontend/src/features/terminal/lspWorkspaceEdit.test.ts` | Pure-function tests |
| `frontend/src/features/terminal/lspExtensions.ts` | CodeMirror extension assembly + DevDeck overrides |
| `frontend/src/features/terminal/lspRename.ts` | Rename orchestration (prepare, plan, apply) |
| `frontend/src/features/terminal/RenameSymbolDialog.tsx` | Rename prompt + affected-files confirmation |

**Modified:**

| File | Change |
|---|---|
| `frontend/package.json` | Add `codemirror-languageserver` (pinned) and `vscode-languageserver-protocol` |
| `frontend/vite.config.ts:61-66` | Add the three new test globs |
| `frontend/src/features/terminal/CodeFileEditor.tsx` | Drop hand-rolled LSP wiring; use `lspExtensions`; add rename dialog + highlight theme classes |
| `frontend/src/features/terminal/FileEditor.tsx:32-40,~231` | Thread `isPathDirty` through to `CodeFileEditor` |
| `frontend/src/features/terminal/ExpandedTerminal.tsx:~174,~697` | Expose a stable `isPathDirty` from the `dirtyFiles` set |
| `COMMANDS.md:442` | Remove `lspClient` from the hand-rolled test-harness list |

---

### Task 1: Dependencies and test wiring

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts:61-66`

**Interfaces:**
- Consumes: nothing.
- Produces: `codemirror-languageserver` and `vscode-languageserver-protocol` importable; `src/features/terminal/lsp*.test.ts` collected by Vitest.

- [ ] **Step 1: Install the two packages**

```bash
cd frontend
npm install --save-exact codemirror-languageserver@1.22.0
npm install --save vscode-languageserver-protocol@^3.17.5
```

- [ ] **Step 2: Verify the pinned version landed without a caret**

Run: `cd frontend && node -p "require('./package.json').dependencies['codemirror-languageserver']"`
Expected: `1.22.0` (no `^`, no `~`)

- [ ] **Step 3: Delete the obsolete hand-rolled harness**

`frontend/src/features/terminal/lspClient.test.ts` is a `check()`-style harness with no `it()` blocks. It is not in the current `test.include` list, so Vitest ignores it today — but the next step adds a glob that would match it, and Vitest fails a file containing no test suite. Task 3 writes its replacement.

```bash
rm frontend/src/features/terminal/lspClient.test.ts
```

- [ ] **Step 4: Register the new test globs**

In `frontend/vite.config.ts`, inside `test.include`, add these three entries after `'src/features/palette/**/*.test.{ts,tsx}'`:

```ts
      'src/features/terminal/lspTransport.test.ts',
      'src/features/terminal/lspClient.test.ts',
      'src/features/terminal/lspWorkspaceEdit.test.ts',
```

A glob that currently matches nothing is fine — Vitest only errors when *no* pattern matches any file.

- [ ] **Step 5: Confirm the suite still passes**

Run: `cd frontend && npm test`
Expected: PASS, all pre-existing tests green.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/features/terminal/lspClient.test.ts
git commit -m "chore(lsp): add codemirror-languageserver and register test globs"
```

---

### Task 2: LSP transport

**Files:**
- Create: `frontend/src/features/terminal/lspTransport.ts`
- Test: `frontend/src/features/terminal/lspTransport.test.ts`

**Interfaces:**
- Consumes: `machineWsUrl(machine, path, params)` from `@/lib/machineClient` (async, returns a `ws://`/`wss://` URL with auth query params already applied).
- Produces:
  - `type LspStatus = 'connecting' | 'installing' | 'ready' | 'error'`
  - `class DevDeckLspTransport implements Transport` with `readonly ready: Promise<{ rootUri: string }>`, `send(message: string): void`, `onMessage(cb: (message: string) => void): void`, `onClose(cb: () => void): void`, `onError(cb: (error: Error) => void): void`, `onStatus(cb: (status: LspStatus, message?: string) => void): () => void`, `getStatus(): LspStatus`, `getStatusMessage(): string | undefined`, `close(): void`
  - `function openLspTransport(machine: Machine, worktreeId: string, language: string): Promise<DevDeckLspTransport>`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/terminal/lspTransport.test.ts`:

```ts
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
    const { socket, transport } = makeTransport()
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/terminal/lspTransport.test.ts`
Expected: FAIL — `Failed to resolve import "./lspTransport"`.

- [ ] **Step 3: Implement the transport**

Create `frontend/src/features/terminal/lspTransport.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/terminal/lspTransport.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/lspTransport.ts frontend/src/features/terminal/lspTransport.test.ts
git commit -m "feat(lsp): transport bridging codemirror-languageserver to /ws/lsp"
```

---

### Task 3: Session and pool

**Files:**
- Rewrite: `frontend/src/features/terminal/lspClient.ts`
- Test: `frontend/src/features/terminal/lspClient.test.ts` (create; the old harness was deleted in Task 1)

**Interfaces:**
- Consumes: `DevDeckLspTransport`, `openLspTransport`, `LspStatus` from `./lspTransport`.
- Produces:
  - `interface LspSession { client: LanguageServerClient; transport: DevDeckLspTransport; rootUri: string; languageId: string; documentUri(path): string; pathFromUri(uri): string | null; getStatus(): LspStatus; getStatusMessage(): string | undefined; subscribeStatus(listener): () => void; dispose(): void }`
  - `function languageIdForPath(path: string): string | null` (behaviour unchanged from the old module)
  - `function createLspSessionPool(): { acquire(key: string, create: () => Promise<LspSession>): Promise<{ session: LspSession; release: () => void }> }` — the creator is supplied per call and only invoked on a cache miss, which keeps the pool free of any machine/socket knowledge and therefore testable without a WebSocket
  - `function acquireLspSession(machine, worktreeId, languageId): Promise<{ session: LspSession; release: () => void }>`
  - `function uriHelpers(rootUri: string): { documentUri, pathFromUri }`

Note for the implementer: the old `LspClient` class, `acquireLspClient`, and every `Lsp*` interface in the old file are deleted. `languageIdForPath` and the private `serverLanguage` helper are the only logic carried over verbatim.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/terminal/lspClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createLspSessionPool, languageIdForPath, uriHelpers } from './lspClient'

describe('languageIdForPath', () => {
  it('maps known extensions and rejects the rest', () => {
    expect(languageIdForPath('main.go')).toBe('go')
    expect(languageIdForPath('src/App.tsx')).toBe('typescriptreact')
    expect(languageIdForPath('src/util.mjs')).toBe('javascript')
    expect(languageIdForPath('script.py')).toBe('python')
    expect(languageIdForPath('README.md')).toBeNull()
    expect(languageIdForPath('Makefile')).toBeNull()
  })
})

describe('uriHelpers', () => {
  const { documentUri, pathFromUri } = uriHelpers('file:///work/repo')

  it('round-trips a nested path', () => {
    const uri = documentUri('src/features/App.tsx')
    expect(uri).toBe('file:///work/repo/src/features/App.tsx')
    expect(pathFromUri(uri)).toBe('src/features/App.tsx')
  })

  it('round-trips a path with characters that need encoding', () => {
    const uri = documentUri('src/my file (copy).go')
    expect(uri).toBe('file:///work/repo/src/my%20file%20(copy).go')
    expect(pathFromUri(uri)).toBe('src/my file (copy).go')
  })

  it('returns null for uris outside the worktree root', () => {
    expect(pathFromUri('file:///usr/local/go/src/fmt/print.go')).toBeNull()
    expect(pathFromUri('file:///work/repo-other/main.go')).toBeNull()
    expect(pathFromUri('not a uri')).toBeNull()
  })
})

describe('createLspSessionPool', () => {
  let next = 0
  function fakeSession() {
    next += 1
    return { id: `session-${next}`, dispose: vi.fn() } as unknown as import('./lspClient').LspSession
  }

  it('shares one session between holders and disposes only on the last release', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const first = await pool.acquire('m1:w1:go', create)
    const second = await pool.acquire('m1:w1:go', create)

    expect(create).toHaveBeenCalledTimes(1)
    expect(first.session).toBe(second.session)

    first.release()
    expect(first.session.dispose).not.toHaveBeenCalled()

    second.release()
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores a repeated release from the same holder', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const first = await pool.acquire('m1:w1:go', create)
    const second = await pool.acquire('m1:w1:go', create)

    first.release()
    first.release()

    expect(second.session.dispose).not.toHaveBeenCalled()
  })

  it('keeps separate sessions per key and recreates after full release', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const go = await pool.acquire('m1:w1:go', create)
    const ts = await pool.acquire('m1:w1:typescript', create)
    expect(go.session).not.toBe(ts.session)

    go.release()
    const goAgain = await pool.acquire('m1:w1:go', create)
    expect(create).toHaveBeenCalledTimes(3)
    expect(goAgain.session).not.toBe(go.session)
  })

  it('does not cache a failed session', async () => {
    const create = vi
      .fn<() => Promise<import('./lspClient').LspSession>>()
      .mockRejectedValueOnce(new Error('gopls is not installed'))
      .mockImplementation(async () => fakeSession())
    const pool = createLspSessionPool()

    await expect(pool.acquire('m1:w1:go', create)).rejects.toThrow('gopls is not installed')

    const retry = await pool.acquire('m1:w1:go', create)
    expect(retry.session).toBeDefined()
    expect(create).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/terminal/lspClient.test.ts`
Expected: FAIL — `createLspSessionPool` / `uriHelpers` are not exported by the current `lspClient.ts`.

- [ ] **Step 3: Rewrite the module**

Replace the entire contents of `frontend/src/features/terminal/lspClient.ts` with:

```ts
import { LanguageServerClient } from 'codemirror-languageserver'
import type { Machine } from '@/store/types'
import {
  openLspTransport,
  type DevDeckLspTransport,
  type LspStatus,
  type LspStatusListener,
} from './lspTransport'

export type { LspStatus }

export interface LspSession {
  readonly client: LanguageServerClient
  readonly transport: DevDeckLspTransport
  readonly rootUri: string
  readonly languageId: string
  documentUri(path: string): string
  pathFromUri(uri: string): string | null
  getStatus(): LspStatus
  getStatusMessage(): string | undefined
  subscribeStatus(listener: LspStatusListener): () => void
  dispose(): void
}

export function languageIdForPath(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'typescriptreact'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'javascriptreact'
    case 'py':
    case 'pyi':
      return 'python'
    case 'rs':
      return 'rust'
    default:
      return null
  }
}

/** Several language ids share one server process, so the pool keys on this. */
function serverLanguage(languageId: string) {
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

/** Worktree-relative path ↔ `file://` uri, both anchored at the root the
 *  backend reported in its `ready` control frame. */
export function uriHelpers(rootUri: string) {
  const root = rootUri.replace(/\/+$/, '')
  return {
    documentUri(path: string) {
      const encoded = path
        .replaceAll('\\', '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')
      return `${root}/${encoded}`
    },
    pathFromUri(uri: string) {
      try {
        const rootUrl = new URL(`${root}/`)
        const target = new URL(uri)
        if (rootUrl.protocol !== target.protocol || rootUrl.host !== target.host) return null
        const rootPath = rootUrl.pathname.endsWith('/') ? rootUrl.pathname : `${rootUrl.pathname}/`
        if (!target.pathname.startsWith(rootPath)) return null
        return decodeURIComponent(target.pathname.slice(rootPath.length))
      } catch {
        return null
      }
    },
  }
}

export async function createLspSession(
  transport: DevDeckLspTransport,
  languageId: string,
): Promise<LspSession> {
  const { rootUri } = await transport.ready
  const { documentUri, pathFromUri } = uriHelpers(rootUri)

  let status: LspStatus = transport.getStatus()
  let statusMessage = transport.getStatusMessage()
  const listeners = new Set<LspStatusListener>()

  const emit = (next: LspStatus, message?: string) => {
    if (status === next && statusMessage === message) return
    status = next
    statusMessage = message
    for (const listener of listeners) listener(next, message)
  }
  const unsubscribe = transport.onStatus(emit)

  const client = new LanguageServerClient({
    transport,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
    // Required by the option type but unused for a shared client — each editor
    // supplies its own documentUri through languageServerPlugin.
    documentUri: rootUri,
    languageId,
    autoClose: false,
    onError: (error) => emit('error', error.message),
    onClose: () => emit('error', 'Language server connection closed'),
  })

  let disposed = false
  return {
    client,
    transport,
    rootUri,
    languageId,
    documentUri,
    pathFromUri,
    getStatus: () => status,
    getStatusMessage: () => statusMessage,
    subscribeStatus(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      listeners.clear()
      client.close()
      transport.close()
    },
  }
}

interface PoolEntry {
  promise: Promise<LspSession>
  refs: number
}

/** Ref-counted session cache. The creator is passed per call and only runs on a
 *  miss, so the pool knows nothing about machines or sockets and can be tested
 *  without either. */
export function createLspSessionPool() {
  const entries = new Map<string, PoolEntry>()

  return {
    async acquire(key: string, create: () => Promise<LspSession>) {
      let entry = entries.get(key)
      if (!entry) {
        entry = { promise: create(), refs: 0 }
        entries.set(key, entry)
      }
      entry.refs += 1

      let session: LspSession
      try {
        session = await entry.promise
      } catch (error) {
        entry.refs -= 1
        if (entries.get(key) === entry) entries.delete(key)
        throw error
      }

      let released = false
      return {
        session,
        release() {
          if (released) return
          released = true
          const current = entries.get(key)
          if (!current || current !== entry) return
          current.refs -= 1
          if (current.refs <= 0) {
            entries.delete(key)
            void current.promise.then((value) => value.dispose()).catch(() => undefined)
          }
        },
      }
    },
  }
}

const pool = createLspSessionPool()

export function acquireLspSession(machine: Machine, worktreeId: string, languageId: string) {
  const language = serverLanguage(languageId)
  return pool.acquire(`${machine.id}:${worktreeId}:${language}`, async () => {
    const transport = await openLspTransport(machine, worktreeId, language)
    return createLspSession(transport, language)
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/terminal/lspClient.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Confirm the old exports are gone**

Run: `cd frontend && grep -rn "acquireLspClient\|LspClient\b" src/ || echo "no references"`
Expected: only `src/features/terminal/CodeFileEditor.tsx` still references them — Task 7 fixes that. `npm run typecheck` therefore fails at this step; that is expected and is not a reason to change `lspClient.ts`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/lspClient.ts frontend/src/features/terminal/lspClient.test.ts
git commit -m "feat(lsp): session pool over LanguageServerClient"
```

---

### Task 4: WorkspaceEdit splitting

**Files:**
- Create: `frontend/src/features/terminal/lspWorkspaceEdit.ts`
- Test: `frontend/src/features/terminal/lspWorkspaceEdit.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; deliberately no imports from `codemirror-languageserver` so it stays trivially testable).
- Produces:
  - `interface LspPosition { line: number; character: number }`
  - `interface LspRange { start: LspPosition; end: LspPosition }`
  - `interface LspTextEdit { range: LspRange; newText: string }`
  - `interface FileEdits { uri: string; path: string; edits: LspTextEdit[] }`
  - `interface SplitEdits { currentEdits: LspTextEdit[]; otherFiles: FileEdits[]; unsupportedOps: string[]; outsideRoot: string[] }`
  - `function splitWorkspaceEdit(edit, currentUri, pathFromUri): SplitEdits`
  - `function applyTextEdits(text: string, edits: LspTextEdit[]): string`
  - `function positionToOffsetInText(text: string, position: LspPosition): number`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/terminal/lspWorkspaceEdit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyTextEdits, splitWorkspaceEdit } from './lspWorkspaceEdit'

const ROOT = 'file:///work/repo'
const pathFromUri = (uri: string) =>
  uri.startsWith(`${ROOT}/`) ? decodeURIComponent(uri.slice(ROOT.length + 1)) : null

function edit(line: number, from: number, to: number, newText: string) {
  return { range: { start: { line, character: from }, end: { line, character: to } }, newText }
}

describe('splitWorkspaceEdit', () => {
  it('separates the current document from other files in a changes map', () => {
    const result = splitWorkspaceEdit(
      {
        changes: {
          [`${ROOT}/main.go`]: [edit(0, 5, 8, 'Bar')],
          [`${ROOT}/pkg/util.go`]: [edit(2, 1, 4, 'Bar'), edit(9, 0, 3, 'Bar')],
        },
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.currentEdits).toHaveLength(1)
    expect(result.otherFiles).toEqual([
      { uri: `${ROOT}/pkg/util.go`, path: 'pkg/util.go', edits: [edit(2, 1, 4, 'Bar'), edit(9, 0, 3, 'Bar')] },
    ])
    expect(result.unsupportedOps).toEqual([])
    expect(result.outsideRoot).toEqual([])
  })

  it('reads documentChanges and merges them with changes for the same uri', () => {
    const result = splitWorkspaceEdit(
      {
        changes: { [`${ROOT}/a.go`]: [edit(0, 0, 1, 'X')] },
        documentChanges: [
          { textDocument: { uri: `${ROOT}/a.go`, version: 2 }, edits: [edit(1, 0, 1, 'Y')] },
          { textDocument: { uri: `${ROOT}/b.go`, version: 1 }, edits: [edit(3, 2, 5, 'Z')] },
        ],
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.currentEdits).toEqual([])
    expect(result.otherFiles.map((file) => file.path)).toEqual(['a.go', 'b.go'])
    expect(result.otherFiles[0]?.edits).toHaveLength(2)
  })

  it('reports file operations instead of applying them', () => {
    const result = splitWorkspaceEdit(
      {
        documentChanges: [
          { kind: 'rename', oldUri: `${ROOT}/a.go`, newUri: `${ROOT}/b.go` },
          { kind: 'delete', uri: `${ROOT}/c.go` },
        ],
      },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.unsupportedOps).toEqual(['rename', 'delete'])
    expect(result.otherFiles).toEqual([])
  })

  it('reports uris that fall outside the worktree root', () => {
    const result = splitWorkspaceEdit(
      { changes: { 'file:///usr/local/go/src/fmt/print.go': [edit(0, 0, 1, 'X')] } },
      `${ROOT}/main.go`,
      pathFromUri,
    )

    expect(result.outsideRoot).toEqual(['file:///usr/local/go/src/fmt/print.go'])
    expect(result.otherFiles).toEqual([])
  })

  it('returns an empty split for a null edit', () => {
    const result = splitWorkspaceEdit(null, `${ROOT}/main.go`, pathFromUri)
    expect(result).toEqual({ currentEdits: [], otherFiles: [], unsupportedOps: [], outsideRoot: [] })
  })
})

describe('applyTextEdits', () => {
  it('applies multiple edits on one line without shifting later ranges', () => {
    const text = 'foo(foo, foo)\n'
    const result = applyTextEdits(text, [edit(0, 0, 3, 'bar'), edit(0, 4, 7, 'bar'), edit(0, 9, 12, 'bar')])
    expect(result).toBe('bar(bar, bar)\n')
  })

  it('applies edits given in arbitrary order', () => {
    const text = 'alpha\nbeta\ngamma\n'
    const result = applyTextEdits(text, [edit(2, 0, 5, 'GAMMA'), edit(0, 0, 5, 'ALPHA')])
    expect(result).toBe('ALPHA\nbeta\nGAMMA\n')
  })

  it('applies an edit spanning multiple lines', () => {
    const text = 'one\ntwo\nthree\n'
    const result = applyTextEdits(text, [
      { range: { start: { line: 0, character: 1 }, end: { line: 2, character: 2 } }, newText: 'X' },
    ])
    expect(result).toBe('oXree\n')
  })

  it('handles insertions at a zero-width range', () => {
    const text = 'ab\n'
    const result = applyTextEdits(text, [edit(0, 1, 1, '-')])
    expect(result).toBe('a-b\n')
  })

  it('clamps positions past the end of a line or document', () => {
    const text = 'ab\n'
    const result = applyTextEdits(text, [
      { range: { start: { line: 9, character: 9 }, end: { line: 9, character: 9 } }, newText: '!' },
    ])
    expect(result).toBe('ab\n!')
  })

  it('returns the input unchanged for an empty edit list', () => {
    expect(applyTextEdits('unchanged\n', [])).toBe('unchanged\n')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/terminal/lspWorkspaceEdit.test.ts`
Expected: FAIL — `Failed to resolve import "./lspWorkspaceEdit"`.

- [ ] **Step 3: Implement the module**

Create `frontend/src/features/terminal/lspWorkspaceEdit.ts`:

```ts
export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface FileEdits {
  uri: string
  path: string
  edits: LspTextEdit[]
}

export interface SplitEdits {
  /** Edits targeting the document currently open in the editor. */
  currentEdits: LspTextEdit[]
  /** Edits targeting other files inside the worktree, in first-seen order. */
  otherFiles: FileEdits[]
  /** `create` / `rename` / `delete` operations, which DevDeck refuses. */
  unsupportedOps: string[]
  /** Uris the server wants to edit that do not resolve inside the worktree. */
  outsideRoot: string[]
}

interface WorkspaceEditLike {
  changes?: Record<string, LspTextEdit[]> | null
  documentChanges?: unknown[] | null
}

function isTextEdit(value: unknown): value is LspTextEdit {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LspTextEdit>
  return (
    typeof candidate.newText === 'string' &&
    !!candidate.range &&
    typeof candidate.range.start?.line === 'number' &&
    typeof candidate.range.end?.line === 'number'
  )
}

/**
 * Flattens a WorkspaceEdit's two possible shapes (`changes` map and
 * `documentChanges` array) into a per-uri view, split by whether the uri is the
 * open document, another worktree file, or something DevDeck cannot apply.
 */
export function splitWorkspaceEdit(
  edit: WorkspaceEditLike | null | undefined,
  currentUri: string,
  pathFromUri: (uri: string) => string | null,
): SplitEdits {
  const byUri = new Map<string, LspTextEdit[]>()
  const unsupportedOps: string[] = []

  const push = (uri: string, edits: LspTextEdit[]) => {
    const existing = byUri.get(uri)
    if (existing) existing.push(...edits)
    else byUri.set(uri, [...edits])
  }

  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    if (Array.isArray(edits)) push(uri, edits.filter(isTextEdit))
  }

  for (const change of edit?.documentChanges ?? []) {
    if (!change || typeof change !== 'object') continue
    const candidate = change as {
      kind?: string
      textDocument?: { uri?: string }
      edits?: unknown[]
    }
    if (typeof candidate.kind === 'string') {
      unsupportedOps.push(candidate.kind)
      continue
    }
    const uri = candidate.textDocument?.uri
    if (!uri || !Array.isArray(candidate.edits)) continue
    push(uri, candidate.edits.filter(isTextEdit))
  }

  const currentEdits: LspTextEdit[] = []
  const otherFiles: FileEdits[] = []
  const outsideRoot: string[] = []

  for (const [uri, edits] of byUri) {
    if (edits.length === 0) continue
    if (uri === currentUri) {
      currentEdits.push(...edits)
      continue
    }
    const path = pathFromUri(uri)
    if (!path) {
      outsideRoot.push(uri)
      continue
    }
    otherFiles.push({ uri, path, edits })
  }

  return { currentEdits, otherFiles, unsupportedOps, outsideRoot }
}

/** Character offset of an LSP position in a plain string, clamped to the text. */
export function positionToOffsetInText(text: string, position: LspPosition): number {
  let offset = 0
  let line = 0
  while (line < position.line) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return text.length
    offset = next + 1
    line += 1
  }
  const lineEnd = text.indexOf('\n', offset)
  const limit = lineEnd < 0 ? text.length : lineEnd
  return Math.min(limit, offset + Math.max(0, position.character))
}

/**
 * Applies edits to a string. Edits are applied back-to-front so that each
 * edit's offsets stay valid against the text it was computed from — LSP
 * guarantees the ranges within one file do not overlap.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      from: positionToOffsetInText(text, edit.range.start),
      to: positionToOffsetInText(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.from - a.from || b.to - a.to)

  let result = text
  for (const edit of resolved) {
    const from = Math.min(edit.from, edit.to)
    const to = Math.max(edit.from, edit.to)
    result = result.slice(0, from) + edit.newText + result.slice(to)
  }
  return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/terminal/lspWorkspaceEdit.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/lspWorkspaceEdit.ts frontend/src/features/terminal/lspWorkspaceEdit.test.ts
git commit -m "feat(lsp): pure WorkspaceEdit splitting and text-edit application"
```

---

### Task 5: CodeMirror extension assembly

**Files:**
- Create: `frontend/src/features/terminal/lspExtensions.ts`

**Interfaces:**
- Consumes: `LspSession` from `./lspClient`; `LspRange` from `./lspWorkspaceEdit`.
- Produces:
  - `interface DefinitionTarget { symbol?: string; range?: LspRange }` — **moved here** from `CodeFileEditor.tsx`, because Task 7 makes `CodeFileEditor` import from this module and a back-import would be circular. `CodeFileEditor.tsx` must re-export it so `FileEditor.tsx` and `ExpandedTerminal.tsx` keep compiling unchanged.
  - `interface DefinitionReveal extends DefinitionTarget { requestId: number }` — moved here for the same reason.
  - `function offsetToPosition(doc: Text, offset: number): LspPosition`
  - `function positionToOffset(doc: Text, position: LspPosition): number`
  - `function revealRange(view: EditorView, range: LspRange): void`
  - `function lspExtensions(options: LspExtensionOptions): Extension[]`
  - `interface LspExtensionOptions { session: LspSession; path: string; onOpenDefinition: (path: string, target: DefinitionTarget) => void; onFallbackDefinition: (view: EditorView, pos: number) => void; onRequestRename: (view: EditorView, pos: number) => void }`

This task has no unit test of its own: every export is either a thin wrapper over the package or requires a live `EditorView` plus a live language server to exercise meaningfully. It is covered by the manual verification in Task 8. Do not write a test that only asserts "the array has N entries" — that tests nothing.

- [ ] **Step 1: Create the module**

Create `frontend/src/features/terminal/lspExtensions.ts`:

```ts
import { autocompletion, completeAnyWord, type CompletionSource } from '@codemirror/autocomplete'
import { Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  formatDocument,
  formatSelection,
  formattingOptions,
  languageServerPlugin,
  languageServerWithTransport,
  SynchronizationMethod,
} from 'codemirror-languageserver'
import { CompletionTriggerKind } from 'vscode-languageserver-protocol'
import { toast } from 'sonner'
import type { LspSession } from './lspClient'
import type { LspPosition, LspRange } from './lspWorkspaceEdit'

export interface DefinitionTarget {
  symbol?: string
  range?: LspRange
}

export interface DefinitionReveal extends DefinitionTarget {
  requestId: number
}

export interface LspExtensionOptions {
  session: LspSession
  path: string
  /** Opens `path` in a tab and reveals the target once it has loaded. */
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  /** Runs the regex/import-resolution fallback when the server has no answer. */
  onFallbackDefinition: (view: EditorView, pos: number) => void
  /** Hands control to React so the rename dialog can open. */
  onRequestRename: (view: EditorView, pos: number) => void
}

export function offsetToPosition(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

export function positionToOffset(doc: Text, position: LspPosition) {
  const lineNumber = Math.min(doc.lines, Math.max(1, position.line + 1))
  const line = doc.line(lineNumber)
  return Math.min(line.to, line.from + Math.max(0, position.character))
}

export function revealRange(view: EditorView, range: LspRange) {
  const anchor = positionToOffset(view.state.doc, range.start)
  const head = positionToOffset(view.state.doc, range.end)
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
  view.focus()
}

function symbolAt(view: EditorView, pos: number) {
  const word = view.state.wordAt(pos)
  return word ? view.state.doc.sliceString(word.from, word.to) : undefined
}

/**
 * Completion source that delegates to the package's plugin but leaves room for
 * `completeAnyWord` behind it. The package ships its own
 * `autocompletion({override: [lspSource]})`, which would drop that fallback, so
 * this reimplements its trigger-character logic and is registered at higher
 * precedence.
 */
function lspCompletionSource(): CompletionSource {
  return async (context) => {
    const view = context.view
    if (!view) return null
    const plugin = view.plugin(languageServerPlugin)
    if (!plugin) return null

    const { state, pos, explicit } = context
    const line = state.doc.lineAt(pos)
    const previous = line.text[pos - line.from - 1]
    let triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked
    let triggerCharacter: string | undefined

    if (
      !explicit &&
      previous !== undefined &&
      plugin.client.capabilities?.completionProvider?.triggerCharacters?.includes(previous)
    ) {
      triggerKind = CompletionTriggerKind.TriggerCharacter
      triggerCharacter = previous
    }
    if (!explicit && triggerKind === CompletionTriggerKind.Invoked && !context.matchBefore(/\w+$/)) {
      return null
    }

    try {
      return await plugin.requestCompletion(context, offsetToPosition(state.doc, pos), {
        triggerKind,
        triggerCharacter,
      })
    } catch {
      return null
    }
  }
}

async function goToDefinition(view: EditorView, pos: number, options: LspExtensionOptions) {
  const plugin = view.plugin(languageServerPlugin)
  if (!plugin) {
    options.onFallbackDefinition(view, pos)
    return
  }

  const symbol = symbolAt(view, pos)
  let location: { uri: string; range: LspRange } | null | undefined
  try {
    location = (await plugin.requestDefinition(view, offsetToPosition(view.state.doc, pos))) as
      | { uri: string; range: LspRange }
      | null
      | undefined
  } catch {
    options.onFallbackDefinition(view, pos)
    return
  }

  if (!location?.uri) {
    options.onFallbackDefinition(view, pos)
    return
  }
  // The package already moved the selection when the definition is in this
  // document; only cross-file results are left for us to handle.
  if (location.uri === options.session.documentUri(options.path)) return

  const target = options.session.pathFromUri(location.uri)
  if (!target) {
    toast.error('Definition is outside this worktree')
    return
  }
  options.onOpenDefinition(target, { symbol, range: location.range })
}

export function lspExtensions(options: LspExtensionOptions): Extension[] {
  const { session, path } = options
  const documentUri = session.documentUri(path)

  return [
    languageServerWithTransport({
      client: session.client,
      // `transport`, `rootUri` and `workspaceFolders` are required by the option
      // type but unused when `client` is supplied — the package only reads them
      // when it has to construct a client itself.
      transport: session.transport,
      rootUri: session.rootUri,
      workspaceFolders: [{ uri: session.rootUri, name: 'worktree' }],
      documentUri,
      languageId: session.languageId,
      allowHTMLContent: false,
      synchronizationMethod: SynchronizationMethod.Incremental,
    }),

    // Registered above the package's own autocompletion so `completeAnyWord`
    // survives as a fallback when the server returns nothing.
    Prec.high(
      autocompletion({
        override: [lspCompletionSource(), completeAnyWord],
      }),
    ),

    // Returning true stops the package's own Ctrl/Cmd-click handler from firing
    // a second, duplicate definition request. preventDefault + focus() must stay
    // in this order: without them a lookup that resolves to "not found" leaves
    // the view permanently unfocused and typing silently goes nowhere.
    Prec.high(
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          event.preventDefault()
          view.focus()
          void goToDefinition(view, pos, options)
          return true
        },
      }),
    ),

    Prec.high(
      keymap.of([
        {
          key: 'F12',
          preventDefault: true,
          run: (view) => {
            void goToDefinition(view, view.state.selection.main.head, options)
            return true
          },
        },
        {
          key: 'F2',
          preventDefault: true,
          run: (view) => {
            options.onRequestRename(view, view.state.selection.main.head)
            return true
          },
        },
        { key: 'Shift-Alt-f', preventDefault: true, run: formatDocument },
        { key: 'Ctrl-k Ctrl-f', preventDefault: true, run: formatSelection },
      ]),
    ),

    formattingOptions.of({ tabSize: 2, insertSpaces: true }),
  ]
}
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "CodeFileEditor" || echo "clean apart from CodeFileEditor"`
Expected: no errors originating in `lspExtensions.ts`. Errors in `CodeFileEditor.tsx` are expected until Task 7.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/terminal/lspExtensions.ts
git commit -m "feat(lsp): assemble CodeMirror extensions with DevDeck overrides"
```

---

### Task 6: Cross-file rename

**Files:**
- Create: `frontend/src/features/terminal/lspRename.ts`
- Create: `frontend/src/features/terminal/RenameSymbolDialog.tsx`

**Interfaces:**
- Consumes: `LspSession` from `./lspClient`; `splitWorkspaceEdit`, `applyTextEdits`, `FileEdits`, `LspTextEdit` from `./lspWorkspaceEdit`; `positionToOffset`, `offsetToPosition` from `./lspExtensions`; `fetchWorktreeFile`, `writeWorktreeFile` from `@/lib/machineApi`; `qk` from `@/features/data/keys`.
- Produces:
  - `interface RenameSubject { symbol: string; position: LspPosition }`
  - `interface RenamePlan { newName: string; currentEdits: LspTextEdit[]; otherFiles: FileEdits[] }`
  - `function prepareRename(view, session, path, pos): Promise<RenameSubject | null>`
  - `function buildRenamePlan(args): Promise<{ ok: true; plan: RenamePlan } | { ok: false; reason: string }>`
  - `function applyRenamePlan(args): Promise<void>` — throws an `Error` whose message names any files already written when a later write fails.
  - `function RenameSymbolDialog(props: RenameSymbolDialogProps)`

- [ ] **Step 1: Create the orchestration module**

Create `frontend/src/features/terminal/lspRename.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query'
import type { EditorView } from '@codemirror/view'
import { qk } from '@/features/data/keys'
import { fetchWorktreeFile, writeWorktreeFile } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import type { LspSession } from './lspClient'
import { offsetToPosition, positionToOffset } from './lspExtensions'
import {
  applyTextEdits,
  splitWorkspaceEdit,
  type FileEdits,
  type LspPosition,
  type LspTextEdit,
} from './lspWorkspaceEdit'

export interface RenameSubject {
  symbol: string
  position: LspPosition
}

export interface RenamePlan {
  newName: string
  currentEdits: LspTextEdit[]
  otherFiles: FileEdits[]
}

/** Asks the server what may be renamed at `pos`, falling back to the word under
 *  the cursor when the server has no prepareRename provider. */
export async function prepareRename(
  view: EditorView,
  session: LspSession,
  path: string,
  pos: number,
): Promise<RenameSubject | null> {
  const position = offsetToPosition(view.state.doc, pos)
  const word = view.state.wordAt(pos)
  const fallback = word ? view.state.doc.sliceString(word.from, word.to) : ''

  try {
    const result = await session.client.textDocumentPrepareRename({
      textDocument: { uri: session.documentUri(path) },
      position,
    })
    if (result && 'placeholder' in result && result.placeholder) {
      return { symbol: result.placeholder, position }
    }
    if (result && 'start' in result) {
      const from = positionToOffset(view.state.doc, result.start)
      const to = positionToOffset(view.state.doc, result.end)
      return { symbol: view.state.doc.sliceString(from, to), position }
    }
  } catch {
    // Server has no prepareRename support, or refused. Fall through.
  }

  return fallback ? { symbol: fallback, position } : null
}

export async function buildRenamePlan(args: {
  session: LspSession
  path: string
  subject: RenameSubject
  newName: string
  /** Reports whether an open tab for `path` has unsaved changes. */
  isPathDirty: (path: string) => boolean
}): Promise<{ ok: true; plan: RenamePlan } | { ok: false; reason: string }> {
  const { session, path, subject, newName, isPathDirty } = args

  let edit
  try {
    edit = await session.client.textDocumentRename({
      textDocument: { uri: session.documentUri(path) },
      position: subject.position,
      newName,
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Rename failed' }
  }

  const split = splitWorkspaceEdit(edit, session.documentUri(path), session.pathFromUri)

  if (split.unsupportedOps.length > 0) {
    const ops = [...new Set(split.unsupportedOps)].join(', ')
    return { ok: false, reason: `This rename needs file ${ops} operations, which DevDeck cannot apply` }
  }
  if (split.outsideRoot.length > 0) {
    return {
      ok: false,
      reason: `This rename touches ${split.outsideRoot.length} file(s) outside this worktree`,
    }
  }
  if (split.currentEdits.length === 0 && split.otherFiles.length === 0) {
    return { ok: false, reason: 'The language server returned no changes for this symbol' }
  }

  // A disk write would silently discard an unsaved buffer, so refuse upfront.
  const dirty = split.otherFiles.map((file) => file.path).filter(isPathDirty)
  if (dirty.length > 0) {
    return { ok: false, reason: `Save ${dirty.join(', ')} before renaming — they have unsaved changes` }
  }

  return { ok: true, plan: { newName, currentEdits: split.currentEdits, otherFiles: split.otherFiles } }
}

/**
 * Applies the plan: the open document through the editor (so it stays unsaved
 * and undoable), every other file straight to disk. A failed write stops the
 * loop and reports what was already written rather than pretending the rename
 * was atomic.
 */
export async function applyRenamePlan(args: {
  view: EditorView
  plan: RenamePlan
  machine: Machine
  worktreeId: string
  queryClient: QueryClient
}): Promise<void> {
  const { view, plan, machine, worktreeId, queryClient } = args

  if (plan.currentEdits.length > 0) {
    const changes = plan.currentEdits
      .map((edit) => ({
        from: positionToOffset(view.state.doc, edit.range.start),
        to: positionToOffset(view.state.doc, edit.range.end),
        insert: edit.newText,
      }))
      .sort((a, b) => a.from - b.from)
    view.dispatch({ changes })
  }

  const written: string[] = []
  try {
    for (const file of plan.otherFiles) {
      const current = await fetchWorktreeFile(machine, worktreeId, file.path)
      const next = applyTextEdits(current.content, file.edits)
      await writeWorktreeFile(machine, worktreeId, { path: file.path, content: next })
      written.push(file.path)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'write failed'
    const partial = written.length > 0 ? ` Already written: ${written.join(', ')}.` : ''
    throw new Error(`Rename stopped after ${written.length} file(s): ${detail}.${partial}`)
  } finally {
    for (const path of written) {
      void queryClient.invalidateQueries({ queryKey: qk.worktreeFile(machine.id, worktreeId, path) })
    }
    if (written.length > 0) {
      void queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
    }
  }
}
```

- [ ] **Step 2: Create the dialog**

Create `frontend/src/features/terminal/RenameSymbolDialog.tsx`. It has two phases in one component — `prompt` (type the new name) and `confirm` (review affected files) — driven by whether `plan` is set:

```tsx
import { useEffect, useState } from 'react'
import { FileWarning, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { RenamePlan } from './lspRename'

export interface RenameSymbolDialogProps {
  open: boolean
  /** The symbol the server says is being renamed. */
  symbol: string
  /** Set once the server has answered; switches the dialog to its confirm phase. */
  plan: RenamePlan | null
  pending: boolean
  currentPath: string
  onCancel: () => void
  /** Phase 1: ask the server what this rename would change. */
  onSubmitName: (newName: string) => void
  /** Phase 2: apply the plan. */
  onConfirmPlan: () => void
}

export function RenameSymbolDialog({
  open,
  symbol,
  plan,
  pending,
  currentPath,
  onCancel,
  onSubmitName,
  onConfirmPlan,
}: RenameSymbolDialogProps) {
  const [name, setName] = useState(symbol)

  // The dialog stays mounted between uses, so re-seed on each open or the
  // previous symbol's name sticks around.
  useEffect(() => {
    if (open) setName(symbol)
  }, [open, symbol])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== symbol && !pending

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()} width={460} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <Pencil size={15} className="text-devdeck-accent-soft" />
        <DialogTitle>{plan ? 'Confirm rename' : `Rename ${symbol}`}</DialogTitle>
      </div>

      {plan ? (
        <>
          <DialogDescription className="mb-3 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
            Renaming to <span className="font-mono text-devdeck-fg-2">{plan.newName}</span> changes{' '}
            {plan.otherFiles.length} other file{plan.otherFiles.length === 1 ? '' : 's'} on disk. Those writes
            happen immediately and cannot be undone from the editor.
          </DialogDescription>
          <ul className="mb-4 max-h-52 overflow-auto rounded border border-devdeck-border-strong bg-devdeck-elevated p-2 font-mono text-[11.5px]">
            {plan.currentEdits.length > 0 && (
              <li className="flex items-center justify-between px-1.5 py-1 text-devdeck-fg-2">
                <span className="truncate">{currentPath}</span>
                <span className="ml-3 shrink-0 text-devdeck-dim">
                  {plan.currentEdits.length} edit{plan.currentEdits.length === 1 ? '' : 's'} · unsaved
                </span>
              </li>
            )}
            {plan.otherFiles.map((file) => (
              <li key={file.path} className="flex items-center justify-between px-1.5 py-1 text-devdeck-fg-2">
                <span className="truncate">{file.path}</span>
                <span className="ml-3 shrink-0 text-devdeck-dim">
                  {file.edits.length} edit{file.edits.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2.5">
            <Button variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onConfirmPlan} disabled={pending}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : null}
              Rename {plan.otherFiles.length + (plan.currentEdits.length > 0 ? 1 : 0)} file
              {plan.otherFiles.length + (plan.currentEdits.length > 0 ? 1 : 0) === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
            The language server decides which references change. You will see the full list before anything is
            written.
          </DialogDescription>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && canSubmit && onSubmitName(trimmed)}
            className="mb-5 font-mono"
            disabled={pending}
            autoFocus
          />
          <div className="flex justify-end gap-2.5">
            <Button variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => canSubmit && onSubmitName(trimmed)} disabled={!canSubmit}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <FileWarning size={12} />}
              Preview changes
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
```

- [ ] **Step 3: Verify both files compile**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lspRename|RenameSymbolDialog" || echo "clean"`
Expected: `clean`. Errors in `CodeFileEditor.tsx` remain expected until Task 7.

- [ ] **Step 4: Check the Button and Input props actually match**

Run: `cd frontend && grep -n "variant" src/components/ui/button.tsx | head -5`
Expected: a `secondary` variant exists. If it does not, use the variant name the file actually defines and adjust the dialog.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/lspRename.ts frontend/src/features/terminal/RenameSymbolDialog.tsx
git commit -m "feat(lsp): cross-file rename planning, application and dialog"
```

---

### Task 7: Wire it into the editor

**Files:**
- Modify: `frontend/src/features/terminal/CodeFileEditor.tsx`
- Modify: `frontend/src/features/terminal/FileEditor.tsx`
- Modify: `frontend/src/features/terminal/ExpandedTerminal.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 3–6.
- Produces: `CodeFileEditor` accepts a new required prop `isPathDirty: (path: string) => boolean`; re-exports `DefinitionTarget` and `DefinitionReveal` from `./lspExtensions` so existing importers are unaffected.

- [ ] **Step 1: Expose `isPathDirty` from ExpandedTerminal**

In `frontend/src/features/terminal/ExpandedTerminal.tsx`, next to the existing `dirtyFiles` state (~line 174), add a ref mirror and a stable callback. A ref is required: the callback is passed into a CodeMirror extension closure that is not recreated on every render, so reading the state variable directly would go stale.

```ts
  const dirtyFilesRef = useRef(dirtyFiles)
  useEffect(() => {
    dirtyFilesRef.current = dirtyFiles
  }, [dirtyFiles])
  const isPathDirty = useCallback((path: string) => dirtyFilesRef.current.has(path), [])
```

Add `useCallback` and `useRef` to the existing `react` import if they are not already there. Then pass it to the `FileEditor` element (~line 700):

```tsx
          onOpenDefinition={openDefinition}
          isPathDirty={isPathDirty}
          reveal={definitionReveals[content.path]}
```

- [ ] **Step 2: Thread it through FileEditor**

In `frontend/src/features/terminal/FileEditor.tsx`, add to `FileEditorProps`:

```ts
  isPathDirty: (path: string) => boolean
```

Destructure `isPathDirty` in the component parameter list alongside `onOpenDefinition`, and pass it to `CodeFileEditor`:

```tsx
            onOpenDefinition={onOpenDefinition}
            isPathDirty={isPathDirty}
            reveal={reveal}
```

Also change the type import at the top from `./CodeFileEditor` to keep working — `CodeFileEditor.tsx` re-exports both types, so this import needs no edit.

- [ ] **Step 3: Rewrite the LSP half of CodeFileEditor**

In `frontend/src/features/terminal/CodeFileEditor.tsx`:

**Delete** these declarations entirely — they now live in the package or in the new modules:
`DefinitionReveal`, `DefinitionTarget`, `offsetToPosition`, `positionToOffset`, `revealRange`, `completionType`, `completionDocumentation`, `plainCompletionText`, `lspCompletionSource`, `diagnosticSeverity`, `codeMirrorDiagnostics`, and the `LspClient`/`LspCompletionItem`/`LspDiagnostic`/`LspPosition`/`LspRange`/`LspStatus` imports.

**Keep** unchanged: `candidateExtensions`, `devdeckCodeTheme`, `syntaxDiagnostics`, `explicitHistoryKeymap`, `escapeRegex`, `identifierRegex`, `normalizeWorkspacePath`, `resolveImportBase`, `resolveImportFile`, `findDefinition`, `quotedPathAt`, `findImportedSource`, `revealDefinition`, `useFileLanguage`, and the reveal effect with its comment block.

**Add** at the top:

```ts
import { useQueryClient } from '@tanstack/react-query'
import {
  acquireLspSession,
  languageIdForPath,
  type LspSession,
  type LspStatus,
} from './lspClient'
import {
  lspExtensions,
  revealRange,
  type DefinitionReveal,
  type DefinitionTarget,
} from './lspExtensions'
import { applyRenamePlan, buildRenamePlan, prepareRename, type RenamePlan, type RenameSubject } from './lspRename'
import { RenameSymbolDialog } from './RenameSymbolDialog'

export type { DefinitionReveal, DefinitionTarget }
```

**Add** these three theme rules inside `devdeckCodeTheme`'s object, after the `.cm-diagnostic-error` block:

```ts
    '.cm-lsp-highlight-text': {
      backgroundColor: 'rgba(216, 216, 212, 0.10)',
    },
    '.cm-lsp-highlight-read': {
      backgroundColor: 'rgba(98, 216, 232, 0.14)',
    },
    '.cm-lsp-highlight-write': {
      backgroundColor: 'rgba(226, 183, 80, 0.18)',
    },
    '.cm-lsp-rename-panel': {
      padding: '4px 8px',
      borderBottom: '1px solid #292b30',
      backgroundColor: '#0d0e10',
    },
```

**Replace** the session acquisition effect (currently lines ~533-586) with:

```ts
  const [session, setSession] = useState<LspSession | null>(null)

  useEffect(() => {
    setSession(null)
    if (!languageId) return
    let cancelled = false
    let releaseFn: (() => void) | null = null
    void acquireLspSession(machine, worktreeId, languageId)
      .then((acquired) => {
        if (cancelled) {
          acquired.release()
          return
        }
        releaseFn = acquired.release
        setSession(acquired.session)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      releaseFn?.()
    }
  }, [languageId, worktreeId, machine])

  useEffect(() => {
    if (!session || !languageId) return
    const toastId = `lsp-status-${worktreeId}-${languageId}`
    let sawInstalling = false
    const handleStatus = (status: LspStatus, message?: string) => {
      if (status === 'installing') {
        sawInstalling = true
        toast.loading(message ?? `Installing ${languageId} language server…`, { id: toastId })
      } else if (status === 'ready' && sawInstalling) {
        toast.success('Language server ready', { id: toastId })
      } else if (status === 'error') {
        toast.error(message ?? 'Language server unavailable', { id: toastId })
      }
    }
    handleStatus(session.getStatus(), session.getStatusMessage())
    return session.subscribeStatus(handleStatus)
  }, [session, languageId, worktreeId])
```

The three effects that called `openDocument` / `changeDocument` / `subscribeDiagnostics` are **deleted** — `languageServerPlugin` owns document sync and diagnostics now.

**Replace** `completionExtension`, `lspDiagnostics` and `definitionNavigation` with a single memo. The old `openFallback` body moves verbatim into `fallbackDefinition`, minus its `lspClient` branch:

```ts
  const fallbackDefinition = useCallback(
    (view: EditorView, position: number) => {
      const source = view.state.doc.toString()
      const quotedPath = quotedPathAt(source, position)
      const word = view.state.wordAt(position)
      const symbol = word ? source.slice(word.from, word.to) : ''
      const namespace = word
        ? source.slice(Math.max(0, word.from - 80), word.from).match(/([A-Za-z_$][\w$]*)\.\s*$/)?.[1]
        : undefined
      const imported = findImportedSource(source, namespace ?? symbol)

      if (!quotedPath && !imported && symbol && revealDefinition(view, source, symbol)) return

      const targetSource = quotedPath ?? imported?.source
      if (!targetSource) {
        if (symbol) toast.error(`Definition for ${symbol} was not found`)
        return
      }

      void resolveImportFile(machine, worktreeId, path, targetSource)
        .then((targetPath) => {
          if (!targetPath) {
            toast.error(`Local file ${targetSource} was not found`)
            return
          }
          onOpenDefinition(targetPath, { symbol: imported?.revealSymbol ?? symbol })
        })
        .catch(() => toast.error(`Could not resolve ${targetSource}`))
    },
    [machine, onOpenDefinition, path, worktreeId],
  )

  const languageExtensions = useMemo(() => {
    if (!session) {
      return [
        autocompletion({ override: [completeAnyWord] }),
        syntaxDiagnostics,
        // Without a language server the only definitions available are the
        // regex/import heuristics, so this handler is the whole feature.
        EditorView.domEventHandlers({
          mousedown(event, view) {
            if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (position === null) return false
            event.preventDefault()
            view.focus()
            fallbackDefinition(view, position)
            return true
          },
        }),
      ]
    }
    return lspExtensions({
      session,
      path,
      onOpenDefinition,
      onFallbackDefinition: fallbackDefinition,
      onRequestRename: (view, pos) => {
        renameViewRef.current = view
        void startRename(view, pos)
      },
    })
  }, [session, path, onOpenDefinition, fallbackDefinition, startRename])
```

`syntaxDiagnostics` appears only in the no-session branch: the package dispatches `setDiagnostics` directly, and a `linter()` source running alongside it would overwrite real diagnostics on every keystroke.

**Add** the rename state and handlers above that memo:

```ts
  const queryClient = useQueryClient()
  const renameViewRef = useRef<EditorView | null>(null)
  const [renameSubject, setRenameSubject] = useState<RenameSubject | null>(null)
  const [renamePlan, setRenamePlan] = useState<RenamePlan | null>(null)
  const [renamePending, setRenamePending] = useState(false)

  const closeRename = useCallback(() => {
    setRenameSubject(null)
    setRenamePlan(null)
    setRenamePending(false)
    renameViewRef.current = null
  }, [])

  const startRename = useCallback(
    async (view: EditorView, pos: number) => {
      if (!session) return
      const subject = await prepareRename(view, session, path, pos)
      if (!subject) {
        toast.error('There is nothing to rename here')
        return
      }
      setRenamePlan(null)
      setRenameSubject(subject)
    },
    [session, path],
  )

  const submitRenameName = useCallback(
    (newName: string) => {
      if (!session || !renameSubject) return
      setRenamePending(true)
      void buildRenamePlan({ session, path, subject: renameSubject, newName, isPathDirty })
        .then((result) => {
          if (!result.ok) {
            toast.error(result.reason)
            closeRename()
            return
          }
          setRenamePlan(result.plan)
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Rename failed')
          closeRename()
        })
        .finally(() => setRenamePending(false))
    },
    [session, path, renameSubject, isPathDirty, closeRename],
  )

  const confirmRename = useCallback(() => {
    const view = renameViewRef.current
    if (!view || !renamePlan) return
    setRenamePending(true)
    void applyRenamePlan({ view, plan: renamePlan, machine, worktreeId, queryClient })
      .then(() => {
        const total = renamePlan.otherFiles.length + (renamePlan.currentEdits.length > 0 ? 1 : 0)
        toast.success(`Renamed across ${total} file${total === 1 ? '' : 's'}`)
        closeRename()
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Rename failed')
        setRenamePending(false)
      })
  }, [renamePlan, machine, worktreeId, queryClient, closeRename])
```

**Update** the component signature. `CodeFileEditor` declares its props inline, so add `isPathDirty` to both the destructured parameter list and the inline type literal that follows it:

```tsx
export function CodeFileEditor({
  worktreeId,
  machine,
  path,
  value,
  ready,
  onChange,
  onOpenDefinition,
  isPathDirty,
  reveal,
}: {
  worktreeId: string
  machine: Machine
  path: string
  value: string
  ready: boolean
  onChange: (value: string) => void
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  /** Reports whether an open tab for `path` has unsaved changes. A cross-file
   *  rename refuses rather than overwrite one. */
  isPathDirty: (path: string) => boolean
  reveal?: DefinitionReveal
}) {
```

Keep the existing doc comment on `ready` — the reveal effect depends on the behaviour it describes.

**Update** the returned JSX to wrap the editor plus the dialog:

```tsx
  return (
    <>
      <CodeMirror
        ref={editorRef}
        value={value}
        height="100%"
        width="100%"
        aria-label={`Edit ${path}`}
        title="Ctrl/Cmd-click a symbol or import to go to its definition · F2 to rename · Shift-Alt-F to format"
        theme="dark"
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          lintKeymap: true,
          tabSize: 2,
        }}
        extensions={[
          oneDark,
          devdeckCodeTheme,
          explicitHistoryKeymap,
          lintGutter(),
          ...languageExtensions,
          ...(language ? [language] : []),
        ]}
        onChange={onChange}
        onCreateEditor={() => setViewReady(true)}
        className="h-full min-h-0 flex-1 overflow-hidden"
      />
      <RenameSymbolDialog
        open={renameSubject !== null}
        symbol={renameSubject?.symbol ?? ''}
        plan={renamePlan}
        pending={renamePending}
        currentPath={path}
        onCancel={closeRename}
        onSubmitName={submitRenameName}
        onConfirmPlan={confirmRename}
      />
    </>
  )
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. If `useCallback`/`useRef`/`EditorView`/`autocompletion`/`completeAnyWord` are reported as missing, add them to the existing imports at the top of the file.

- [ ] **Step 5: Run the full suite**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Build**

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/terminal/CodeFileEditor.tsx frontend/src/features/terminal/FileEditor.tsx frontend/src/features/terminal/ExpandedTerminal.tsx
git commit -m "feat(lsp): drive CodeFileEditor through codemirror-languageserver"
```

---

### Task 8: Documentation and end-to-end verification

**Files:**
- Modify: `COMMANDS.md:442`

**Interfaces:**
- Consumes: the finished feature.
- Produces: accurate docs, a verified build.

- [ ] **Step 1: Update the hand-rolled test-harness list**

In `COMMANDS.md` line 442, remove `lspClient` from the list (it is now a Vitest suite):

```
  features/terminal/  archiveName, fileTreeSelection, paneTree
```

If the surrounding paragraph states a count of hand-rolled files, decrement it.

- [ ] **Step 2: Confirm no stale references to the old API remain**

Run: `cd frontend && grep -rn "acquireLspClient\|new LspClient\|LspCompletionItem\|codeMirrorDiagnostics" src/ || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Run every gate**

```bash
cd frontend && npm run typecheck && npm test && npm run build
cd ../backend && go vet ./...
```
Expected: all pass. `go vet` is included only to prove the backend was untouched.

- [ ] **Step 4: Manual verification against a real worktree**

Start the app (`cd frontend && npm run dev`), open a worktree containing Go or TypeScript, open a source file, and confirm each of the following. Record the result of each — a skipped check is a failed check.

1. Hover a symbol → tooltip with signature and docs appears, styled dark.
2. Type a `.` after a package or object → completions appear; a nonsense prefix still offers `completeAnyWord` results.
3. Ctrl/Cmd-click a symbol defined in **another** file → that file opens in a new tab with the symbol selected.
4. Ctrl/Cmd-click a symbol defined in the **same** file → selection moves, no new tab.
5. Ctrl/Cmd-click an import string with no language server available (e.g. a `.css` file) → the regex fallback still resolves it.
6. Put the cursor on a symbol → other occurrences highlight.
7. Introduce a type error → a red squiggle appears with the server's message, and it does **not** flicker while typing.
8. `Shift-Alt-F` → the document is formatted.
9. `F2` on a symbol used in two files → prompt appears, then a confirmation listing both files, then both are updated and the other file's open tab reloads.
10. `F2` while another affected file has unsaved changes → refused with a toast naming that file, nothing written.
11. Open a file whose language server is not installed → the install toast appears, then either "Language server ready" or an error toast, and the editor stays usable either way.

- [ ] **Step 5: Commit**

```bash
git add COMMANDS.md
git commit -m "docs(lsp): drop lspClient from the hand-rolled test list"
```

---

## Self-Review Notes

Checked against the spec:

- Spec §Transport → Task 2 (all three behaviours, all tested).
- Spec §Client pool → Task 3 (refcounting, uri helpers, status; `autoClose: false` set).
- Spec §Extension composition → Task 5 (aggregate + three `Prec.high` overrides), with `syntaxDiagnostics` suppression in Task 7 Step 3.
- Spec §Rename, all six numbered steps → Task 6 (`buildRenamePlan` covers refusals 3a–3c; `applyRenamePlan` covers 5 and 6) and Task 7 (dialog wiring, step 4).
- Spec §Error handling table → Task 7 Step 3 status effect, plus the no-session fallback branch.
- Spec §Testing → Tasks 2–4 unit tests; Task 8 Step 4 covers the manual list. `lspExtensions.test.ts` from the spec's list is deliberately **not** written — see the note in Task 5; the spec's proposed assertions ("completion falls back", "handler returns true") require either a live server or a mock so heavy it would only assert the mock. This is a knowing deviation, and the manual checks 2, 3 and 5 cover the same ground.
