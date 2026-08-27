import { MonacoLspClient } from 'monaco-lsp-client'
import { openModelUris } from '@/features/editor/openModelUris'
import { monaco } from '@/features/editor/monacoSetup'
import {
  createRangeSemanticTokensProvider,
  monacoLanguagesFor,
  semanticTokensLegendFrom,
} from '@/features/editor/rangeSemanticTokens'
import type { Machine } from '@/store/types'
import {
  openLspTransport,
  serverLanguage,
  type DevDeckLspTransport,
  type LspStatus,
  type LspStatusListener,
} from './lspTransport'

export type { LspStatus }

export interface LspSession {
  readonly client: MonacoLspClient
  readonly transport: DevDeckLspTransport
  readonly rootUri: string
  readonly languageId: string
  documentUri(path: string): string
  pathFromUri(uri: string): string | null
  getStatus(): LspStatus
  getStatusMessage(): string | undefined
  /** True when this session's server was answering and then stopped — see
   *  `DevDeckLspTransport.isLost`. Distinct from `getStatus() === 'error'`,
   *  which also covers a server that never came up at all. */
  isLost(): boolean
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

  // Constructing the client immediately sends `initialize`; the transport
  // rewrites it in transit to carry the real rootUri. One client per session,
  // and the pool guarantees one session per machine:worktree:language — monaco's
  // provider registry is keyed by language, not by editor, so a client per
  // editor instance would fan out duplicate completions across split panes.
  const client = new MonacoLspClient(transport)

  // Viewport semantic tokens — the only way a file past the server's whole-file
  // limit gets coloured at all. gopls refuses `semanticTokens/full` over 100 kB
  // and `MonacoLspClient` registers no range provider to fall back on, so a big
  // file is left to the monarch grammar for the life of the tab even though
  // hover and go-to-definition keep working on it. Registered as soon as the
  // legend arrives, since monaco cannot decode a token without it; the
  // registration is itself the registry change that starts monaco's viewport
  // pass on every model already open. See rangeSemanticTokens.ts.
  const rangeProviders: Array<{ dispose(): void }> = []
  transport.onMessage((raw) => {
    if (rangeProviders.length > 0) return
    const legend = semanticTokensLegendFrom(raw)
    if (!legend) return
    const provider = createRangeSemanticTokensProvider(legend, (uri, range) =>
      transport.request('textDocument/semanticTokens/range', { textDocument: { uri }, range }),
    )
    for (const id of monacoLanguagesFor(languageId)) {
      rangeProviders.push(monaco.languages.registerDocumentRangeSemanticTokensProvider(id, provider))
    }
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
    isLost: () => transport.isLost(),
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
      for (const provider of rangeProviders) provider.dispose()
      rangeProviders.length = 0
      transport.close()
    },
  }
}

interface PoolEntry {
  promise: Promise<LspSession>
  refs: number
  session?: LspSession
  idleTimer?: ReturnType<typeof setTimeout>
}

/** How long a session with no holders is kept before it is really disposed.
 *  Long enough to cover the gap between closing one file and opening the next
 *  (see `release` for why that gap is worth paying for), short enough that a
 *  worktree the operator has moved on from stops holding a language server
 *  process on the machine. */
const IDLE_DISPOSE_MS = 30_000

/** Ref-counted session cache. The creator is passed per call and only runs on a
 *  miss, so the pool knows nothing about machines or sockets and can be tested
 *  without either. */
export function createLspSessionPool(idleDisposeMs = IDLE_DISPOSE_MS) {
  const entries = new Map<string, PoolEntry>()

  function cancelIdleDisposal(entry: PoolEntry) {
    if (entry.idleTimer === undefined) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  return {
    async acquire(key: string, create: () => Promise<LspSession>) {
      let entry = entries.get(key)
      if (entry) {
        cancelIdleDisposal(entry)
        // A session is only worth reusing while its server still answers. One
        // whose socket died would otherwise be handed to the next file that
        // opens, leaving that file with no language support at all until the
        // page is reloaded.
        //
        // This deliberately does NOT require the entry to be idle. A session
        // only reports `'error'` once its transport is unusable (see
        // lspTransport's `failFromClosedSocket`), so disposing it takes nothing
        // away from the editors still holding it — there is no live socket left
        // to close under them. Waiting for `refs === 0` sounded safer but made
        // the check almost unreachable in practice: `FileEditor` keeps every
        // open tab mounted, so one open `.go` file pins the refcount above zero
        // and every *other* Go file opened afterwards was handed the same
        // corpse. Their `release()` no-ops once this entry leaves the map (it
        // compares identity), which is correct — it has been disposed here.
        if (entry.session?.getStatus() === 'error') {
          entries.delete(key)
          entry.session.dispose()
          entry = undefined
        }
      }
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
        /**
         * Drops this holder's claim. The session outlives the last one by
         * `idleDisposeMs` rather than being torn down on the spot.
         *
         * Closing the only open `.go` file and opening another one takes the
         * refcount through zero, and disposing there ends the session's
         * transport while its `MonacoLspClient` lives on: the client cannot be
         * disposed (see `answerWithoutServer` in lspTransport.ts) and stays
         * registered with monaco forever, so the reopen stacks a second client
         * on top of a dead one — and pays a full language-server restart for
         * the privilege. Holding the session across that gap means the reopen
         * gets the same live client back.
         */
        release() {
          if (released) return
          released = true
          const current = entries.get(key)
          if (!current || current !== entry) return
          current.refs -= 1
          if (current.refs > 0) return
          cancelIdleDisposal(current)
          current.idleTimer = setTimeout(() => {
            current.idleTimer = undefined
            if (entries.get(key) !== current || current.refs > 0) return
            entries.delete(key)
            current.session?.dispose()
          }, idleDisposeMs)
        },
      }
    },
  }
}

const pool = createLspSessionPool()

export function acquireLspSession(machine: Machine, worktreeId: string, languageId: string) {
  const language = serverLanguage(languageId)
  return pool.acquire(`${machine.id}:${worktreeId}:${language}`, async () => {
    const transport = await openLspTransport(machine, worktreeId, language, openModelUris)
    return createLspSession(transport, language)
  })
}
