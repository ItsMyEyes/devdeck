import { monaco } from './monacoSetup'

/**
 * Every live model's uri, with its real capitalisation.
 *
 * This is the same list `MonacoLspClient`'s `TextDocumentSynchronizer` walks
 * (`editor.getModels()` / `onDidCreateModel`) to decide what to announce to a
 * language server, and `toString(true)` is the same form its `ManagedModel`
 * derives the outbound uri from — before lowercasing it. Reading it back here
 * is what lets the transport undo that lowercasing; see
 * `restoreDocumentUriCase` in lspTransport.ts.
 */
export function openModelUris(): string[] {
  return monaco.editor.getModels().map((model) => model.uri.toString(true))
}
