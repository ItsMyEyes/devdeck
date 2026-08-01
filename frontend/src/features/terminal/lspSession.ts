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
  session?: LspSession
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
        entry.session = session
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
            current.session?.dispose()
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
