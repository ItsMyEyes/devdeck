/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's convention
 * (no Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/features/terminal/lspClient.test.ts
 */

import { LspClient, languageIdForPath, type LspStatus } from './lspClient'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

// Minimal fake WebSocket so LspClient (which does `new WebSocket(url)`
// directly, with no injection point) can be exercised outside a browser.
// Tracks every instance created so a test can grab the one its LspClient
// just constructed and drive it by dispatching fake server messages.
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  url: string
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', {})
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

// lspClient.ts uses window.setTimeout/window.clearTimeout (browser APIs);
// alias window to globalThis so those resolve under plain Node/tsx too.
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no FakeWebSocket instance was created')
  return socket
}

function serverMessage(payload: unknown) {
  return { data: JSON.stringify(payload) }
}

function waitForStatus(client: LspClient, target: LspStatus): Promise<void> {
  return new Promise((resolve) => {
    if (client.getStatus() === target) {
      resolve()
      return
    }
    const unsubscribe = client.subscribeStatus((status) => {
      if (status === target) {
        unsubscribe()
        resolve()
      }
    })
  })
}

check('languageIdForPath: go', () => {
  assertEqual(languageIdForPath('a/b/c.go'), 'go', 'c.go')
})

check('languageIdForPath: typescript', () => {
  assertEqual(languageIdForPath('src/store/useDevDeckStore.ts'), 'typescript', 'useDevDeckStore.ts')
})

check('languageIdForPath: typescriptreact', () => {
  assertEqual(languageIdForPath('src/features/terminal/CodeFileEditor.tsx'), 'typescriptreact', 'CodeFileEditor.tsx')
})

check('languageIdForPath: javascript (js, mjs, cjs)', () => {
  assertEqual(languageIdForPath('scripts/build.js'), 'javascript', 'build.js')
  assertEqual(languageIdForPath('scripts/build.mjs'), 'javascript', 'build.mjs')
  assertEqual(languageIdForPath('scripts/build.cjs'), 'javascript', 'build.cjs')
})

check('languageIdForPath: javascriptreact', () => {
  assertEqual(languageIdForPath('src/App.jsx'), 'javascriptreact', 'App.jsx')
})

check('languageIdForPath: python (py, pyi)', () => {
  assertEqual(languageIdForPath('tools/markitdown.py'), 'python', 'markitdown.py')
  assertEqual(languageIdForPath('tools/stubs/markitdown.pyi'), 'python', 'markitdown.pyi')
})

check('languageIdForPath: rust', () => {
  assertEqual(languageIdForPath('frontend/src-tauri/src/lib.rs'), 'rust', 'lib.rs')
})

check('languageIdForPath: java', () => {
  assertEqual(languageIdForPath('src/Main.java'), 'java', 'Main.java')
})

check('languageIdForPath: unrecognized extension returns null', () => {
  assertEqual(languageIdForPath('README.txt'), null, 'txt')
})

check('languageIdForPath: no extension returns null', () => {
  assertEqual(languageIdForPath('Makefile'), null, 'no extension')
})

await checkAsync('LspClient: starts in connecting status', async () => {
  const client = new LspClient('ws://test/lsp')
  assertEqual(client.getStatus(), 'connecting', 'initial status')
})

await checkAsync(
  'LspClient: installing control message notifies subscribers, then transitions to ready',
  async () => {
    const client = new LspClient('ws://test/lsp')
    const socket = latestSocket()

    let sawInstalling = false
    client.subscribeStatus((status) => {
      if (status === 'installing') sawInstalling = true
    })

    socket.dispatch('message', serverMessage({ devdeckLsp: { type: 'installing', language: 'go' } }))
    assertEqual(sawInstalling, true, 'installing status observed by subscriber')
    assertEqual(client.getStatus(), 'installing', 'status field updated to installing')

    socket.dispatch(
      'message',
      serverMessage({ devdeckLsp: { type: 'ready', rootUri: 'file:///workspace' } }),
    )

    const initializeRequest = JSON.parse(socket.sent.at(-1) as string) as {
      id: number
      method: string
    }
    assertEqual(initializeRequest.method, 'initialize', 'client sent an initialize request after ready')

    const becameReady = waitForStatus(client, 'ready')
    socket.dispatch(
      'message',
      serverMessage({ jsonrpc: '2.0', id: initializeRequest.id, result: { capabilities: {} } }),
    )
    await becameReady
    assertEqual(client.getStatus(), 'ready', 'status becomes ready once initialize resolves')
  },
)

await checkAsync('LspClient: error control message notifies subscribers', async () => {
  const client = new LspClient('ws://test/lsp')
  const socket = latestSocket()

  let sawError = false
  client.subscribeStatus((status) => {
    if (status === 'error') sawError = true
  })

  socket.dispatch(
    'message',
    serverMessage({ devdeckLsp: { type: 'error', message: 'gopls is not installed' } }),
  )

  assertEqual(sawError, true, 'error status observed by subscriber')
  assertEqual(client.getStatus(), 'error', 'status field updated to error')
})

await checkAsync('LspClient: unsubscribeStatus stops further notifications', async () => {
  const client = new LspClient('ws://test/lsp')
  const socket = latestSocket()

  let calls = 0
  const unsubscribe = client.subscribeStatus(() => {
    calls += 1
  })
  socket.dispatch('message', serverMessage({ devdeckLsp: { type: 'installing', language: 'go' } }))
  unsubscribe()
  socket.dispatch('message', serverMessage({ devdeckLsp: { type: 'error', message: 'boom' } }))

  assertEqual(calls, 1, 'listener stops receiving updates after unsubscribe')
})

console.log(`\n${passed} passed`)
