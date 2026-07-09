import type { Machine } from '@/store/types'
import { machineWsUrl } from '@/lib/machineClient'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { kind?: string; value: string }
  insertText?: string
  insertTextFormat?: number
  textEdit?: { newText: string; range: LspRange }
  sortText?: string
}

export interface LspDefinition {
  uri: string
  path: string | null
  range: LspRange
}

interface OpenDocument {
  path: string
  uri: string
  languageId: string
  text: string
  version: number
  opened: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: number
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
  loomLsp?: {
    type: 'ready' | 'error'
    message?: string
    language?: string
    rootUri?: string
  }
}

interface InitializeResult {
  capabilities?: {
    textDocumentSync?: number | { change?: number }
  }
}

interface Location {
  uri: string
  range: LspRange
}

interface LocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}

const clients = new Map<string, { clientPromise: Promise<LspClient>; refs: number }>()

export function languageIdForPath(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'go':
      return 'go'
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

async function createLspClient(machine: Machine, worktreeId: string, language: string): Promise<LspClient> {
  const url = await machineWsUrl(machine, '/lsp', { worktree: worktreeId, language })
  return new LspClient(url)
}

export async function acquireLspClient(machine: Machine, worktreeId: string, languageId: string) {
  const language = serverLanguage(languageId)
  const key = `${machine.id}:${worktreeId}:${language}`
  let entry = clients.get(key)
  if (!entry) {
    entry = { clientPromise: createLspClient(machine, worktreeId, language), refs: 0 }
    clients.set(key, entry)
  }
  entry.refs += 1
  let released = false
  const client = await entry.clientPromise

  return {
    client,
    release() {
      if (released) return
      released = true
      const current = clients.get(key)
      if (!current) return
      current.refs -= 1
      if (current.refs <= 0) {
        clients.delete(key)
        void current.clientPromise.then((c) => c.dispose())
      }
    },
  }
}

export class LspClient {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<string, OpenDocument>()
  private readonly diagnostics = new Map<string, LspDiagnostic[]>()
  private readonly diagnosticListeners = new Map<
    string,
    Set<(diagnostics: LspDiagnostic[]) => void>
  >()
  private requestId = 0
  private rootUri = ''
  private initialized = false
  private disposed = false
  private syncKind = 1
  private resolveReady!: () => void
  private rejectReady!: (reason: Error) => void
  private readonly ready: Promise<void>

  constructor(url: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => this.handleMessage(event))
    this.socket.addEventListener('close', () => {
      if (!this.disposed && !this.initialized) {
        this.rejectReady(new Error('Language server connection closed'))
      }
      this.rejectPending(new Error('Language server connection closed'))
    })
    this.socket.addEventListener('error', () => {
      if (!this.initialized) {
        this.rejectReady(new Error('Could not connect to the language server'))
      }
    })
  }

  openDocument(path: string, languageId: string, text: string) {
    const existing = this.documents.get(path)
    if (existing) {
      existing.languageId = languageId
      existing.text = text
      return
    }
    const document: OpenDocument = {
      path,
      uri: '',
      languageId,
      text,
      version: 1,
      opened: false,
    }
    this.documents.set(path, document)
    void this.ready
      .then(() => this.ensureDocumentOpen(document))
      .catch(() => undefined)
  }

  changeDocument(path: string, text: string) {
    const document = this.documents.get(path)
    if (!document || document.text === text) return
    const previousText = document.text
    document.text = text
    document.version += 1
    if (!this.initialized || !document.opened) return

    const contentChanges =
      this.syncKind === 2
        ? [
            {
              range: {
                start: { line: 0, character: 0 },
                end: endPosition(previousText),
              },
              text,
            },
          ]
        : [{ text }]
    this.notify('textDocument/didChange', {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges,
    })
  }

  closeDocument(path: string) {
    const document = this.documents.get(path)
    if (!document) return
    if (this.initialized && document.opened) {
      this.notify('textDocument/didClose', {
        textDocument: { uri: document.uri },
      })
    }
    this.documents.delete(path)
    this.diagnostics.delete(path)
    this.emitDiagnostics(path, [])
  }

  getDiagnostics(path: string) {
    return this.diagnostics.get(path) ?? []
  }

  subscribeDiagnostics(
    path: string,
    listener: (diagnostics: LspDiagnostic[]) => void,
  ) {
    let listeners = this.diagnosticListeners.get(path)
    if (!listeners) {
      listeners = new Set()
      this.diagnosticListeners.set(path, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.diagnosticListeners.delete(path)
    }
  }

  async completion(path: string, position: LspPosition) {
    const document = this.documents.get(path)
    if (!document) return []
    await this.ready
    await this.ensureDocumentOpen(document)
    const result = await this.request('textDocument/completion', {
      textDocument: { uri: document.uri },
      position,
      context: { triggerKind: 1 },
    })
    if (Array.isArray(result)) return result as LspCompletionItem[]
    if (result && typeof result === 'object' && 'items' in result) {
      const items = (result as { items?: LspCompletionItem[] }).items
      return Array.isArray(items) ? items : []
    }
    return []
  }

  async definition(path: string, position: LspPosition) {
    const document = this.documents.get(path)
    if (!document) return []
    await this.ready
    await this.ensureDocumentOpen(document)
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: document.uri },
      position,
    })
    const raw = Array.isArray(result) ? result : result ? [result] : []
    return raw.flatMap((candidate): LspDefinition[] => {
      if (!candidate || typeof candidate !== 'object') return []
      if ('targetUri' in candidate) {
        const link = candidate as LocationLink
        return [
          {
            uri: link.targetUri,
            path: this.pathFromUri(link.targetUri),
            range: link.targetSelectionRange ?? link.targetRange,
          },
        ]
      }
      if ('uri' in candidate && 'range' in candidate) {
        const location = candidate as Location
        return [
          {
            uri: location.uri,
            path: this.pathFromUri(location.uri),
            range: location.range,
          },
        ]
      }
      return []
    })
  }

  dispose() {
    if (this.disposed) return
    const close = () => {
      this.disposed = true
      if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000)
      this.rejectPending(new Error('Language server client was disposed'))
    }
    if (!this.initialized || this.socket.readyState !== WebSocket.OPEN) {
      close()
      return
    }
    void this.requestNow('shutdown', null)
      .catch(() => undefined)
      .finally(() => {
        this.notify('exit', null)
        close()
      })
  }

  private async initialize(rootUri: string) {
    this.rootUri = rootUri.replace(/\/+$/, '')
    const result = (await this.requestNow('initialize', {
      processId: null,
      clientInfo: { name: 'loom', version: '0.1.0' },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: 'worktree' }],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              documentationFormat: ['markdown', 'plaintext'],
              snippetSupport: false,
            },
          },
          definition: { dynamicRegistration: false, linkSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
      },
    })) as InitializeResult
    const sync = result.capabilities?.textDocumentSync
    this.syncKind = typeof sync === 'number' ? sync : (sync?.change ?? 1)
    this.initialized = true
    this.notify('initialized', {})
    this.resolveReady()
    for (const document of this.documents.values()) {
      await this.ensureDocumentOpen(document)
    }
  }

  private async ensureDocumentOpen(document: OpenDocument) {
    if (
      this.disposed ||
      document.opened ||
      !this.initialized ||
      this.documents.get(document.path) !== document
    ) {
      return
    }
    document.uri = this.documentUri(document.path)
    document.opened = true
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      },
    })
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== 'string') return
    let message: RpcMessage
    try {
      message = JSON.parse(event.data) as RpcMessage
    } catch {
      return
    }

    if (message.loomLsp) {
      if (message.loomLsp.type === 'error') {
        this.rejectReady(
          new Error(message.loomLsp.message ?? 'Language server unavailable'),
        )
        return
      }
      if (message.loomLsp.type === 'ready' && message.loomLsp.rootUri) {
        void this.initialize(message.loomLsp.rootUri).catch((error: unknown) => {
          this.rejectReady(toError(error))
        })
      }
      return
    }

    if (message.id !== undefined && !message.method) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const pending = this.pending.get(id)
      if (!pending) return
      window.clearTimeout(pending.timeout)
      this.pending.delete(id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Language server error'))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method && message.id !== undefined) {
      this.respondToServer(message)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as {
        uri?: string
        diagnostics?: LspDiagnostic[]
      }
      if (!params.uri) return
      const path = this.pathFromUri(params.uri)
      if (!path) return
      const diagnostics = Array.isArray(params.diagnostics)
        ? params.diagnostics
        : []
      this.diagnostics.set(path, diagnostics)
      this.emitDiagnostics(path, diagnostics)
    }
  }

  private respondToServer(message: RpcMessage) {
    let result: unknown = null
    if (message.method === 'workspace/configuration') {
      const items = (message.params as { items?: unknown[] } | undefined)?.items
      result = Array.isArray(items) ? items.map(() => null) : []
    } else if (message.method === 'workspace/applyEdit') {
      result = { applied: false, failureReason: 'Workspace edits are not supported' }
    }
    this.send({ jsonrpc: '2.0', id: message.id, result })
  }

  private request(method: string, params: unknown) {
    return this.ready.then(() => this.requestNow(method, params))
  }

  private requestNow(method: string, params: unknown) {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Language server is not connected'))
    }
    const id = ++this.requestId
    return new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 15_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown) {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: RpcMessage) {
    this.socket.send(JSON.stringify(message))
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private emitDiagnostics(path: string, diagnostics: LspDiagnostic[]) {
    for (const listener of this.diagnosticListeners.get(path) ?? []) {
      listener(diagnostics)
    }
  }

  private documentUri(path: string) {
    const encoded = path
      .replaceAll('\\', '/')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return `${this.rootUri}/${encoded}`
  }

  private pathFromUri(uri: string) {
    try {
      const root = new URL(`${this.rootUri}/`)
      const target = new URL(uri)
      if (root.protocol !== target.protocol || root.host !== target.host) return null
      const rootPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`
      if (!target.pathname.startsWith(rootPath)) return null
      return decodeURIComponent(target.pathname.slice(rootPath.length))
    } catch {
      return null
    }
  }
}

function endPosition(text: string): LspPosition {
  const lines = text.split('\n')
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}
