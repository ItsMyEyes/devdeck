import { describe, expect, it } from 'vitest'
import { autocompletion, completeAnyWord } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { languageServerWithTransport, SynchronizationMethod } from 'codemirror-languageserver'
import { BUNDLED_AUTOCOMPLETION_INDEX, lspExtensions } from './lspExtensions'
import type { LspSession } from './lsp/lspSession'

const ROOT = 'file:///work/repo'

/** Enough of a session for `EditorState.create` — it resolves facets but never
 *  constructs ViewPlugins, so the client is only stored, never called. */
function fakeSession(): LspSession {
  return {
    client: { capabilities: {}, ready: false, attachPlugin() {}, detachPlugin() {} },
    transport: { send() {}, onMessage() {}, onClose() {}, onError() {}, close() {} },
    rootUri: ROOT,
    languageId: 'go',
    documentUri: (path: string) => `${ROOT}/${path}`,
    pathFromUri: (uri: string) => (uri.startsWith(`${ROOT}/`) ? uri.slice(ROOT.length + 1) : null),
    getStatus: () => 'ready' as const,
    getStatusMessage: () => undefined,
    subscribeStatus: () => () => undefined,
    dispose: () => undefined,
  } as unknown as LspSession
}

function packageBundle() {
  const session = fakeSession()
  return languageServerWithTransport({
    client: session.client,
    transport: session.transport,
    rootUri: ROOT,
    workspaceFolders: [{ uri: ROOT, name: 'worktree' }],
    documentUri: `${ROOT}/main.go`,
    languageId: 'go',
    allowHTMLContent: false,
    synchronizationMethod: SynchronizationMethod.Incremental,
  })
}

describe('lspExtensions', () => {
  it('builds an EditorState instead of throwing a completion config conflict', () => {
    expect(() =>
      EditorState.create({
        doc: 'package main\n',
        extensions: lspExtensions({
          session: fakeSession(),
          path: 'main.go',
          onOpenDefinition: () => undefined,
          onFallbackDefinition: () => undefined,
          onRequestRename: () => undefined,
        }),
      }),
    ).not.toThrow()
  })

  // This is the load-bearing assumption behind BUNDLED_AUTOCOMPLETION_INDEX.
  // @codemirror/state's combineConfig has no merge function for `override`, so
  // two autocompletion() calls in one state throw. The package's aggregate
  // bundles its own; we drop it by index. If an upgrade reorders that array,
  // this test fails rather than every LSP-backed editor crashing on mount.
  it('pins the bundled autocompletion to exactly one index of the package aggregate', () => {
    const bundle = packageBundle()
    expect(bundle).toHaveLength(7)

    for (let index = 0; index < bundle.length; index += 1) {
      const build = () =>
        EditorState.create({
          doc: '',
          extensions: [
            bundle.filter((_, position) => position !== index),
            autocompletion({ override: [completeAnyWord] }),
          ],
        })

      if (index === BUNDLED_AUTOCOMPLETION_INDEX) expect(build).not.toThrow()
      else expect(build).toThrow(/Config merge conflict for field override/)
    }
  })
})
