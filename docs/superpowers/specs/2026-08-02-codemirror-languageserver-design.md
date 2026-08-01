# CodeMirror Language Server Integration — Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Replace DevDeck's hand-rolled LSP client (`frontend/src/features/terminal/lspClient.ts`, 592 lines) with
[`codemirror-languageserver@1.22.0`](https://www.npmjs.com/package/codemirror-languageserver), gaining hover
documentation, document highlight, formatting, and cross-file rename, while preserving every DevDeck-specific
behaviour the package does not cover.

## Current State

**Backend — no changes required.** `backend/internal/lsp/server.go` already bridges
`/ws/lsp?worktree=<id>&language=<lang>` to a real language server process (gopls, typescript-language-server,
pyright-langserver, rust-analyzer, jdtls), auto-installing the binary when missing. Before any LSP traffic it
writes control frames wrapped in a `devdeckLsp` envelope:

| Type | Payload | Meaning |
|---|---|---|
| `installing` | `message`, `language` | Binary is being installed; may repeat |
| `ready` | `language`, `rootUri` | Server process is live; `rootUri` is the resolved worktree root |
| `error` | `message` | Fatal; socket closes with `StatusPolicyViolation` |

**Frontend.** `lspClient.ts` implements JSON-RPC by hand: `initialize`, `didOpen`/`didChange`/`didClose`,
`textDocument/completion`, `textDocument/definition`, and `publishDiagnostics`. `CodeFileEditor.tsx` (772 lines)
wires it into CodeMirror as a completion source, a `linter()` source, and a Ctrl/Cmd-click `domEventHandlers`
entry with a regex-based fallback. Only worktree files get LSP; SSH files and untitled buffers render
`PlainCodeEditor` and are out of scope.

## Package Findings

Verified against the published `dist/` of `codemirror-languageserver@1.22.0`. These four findings drive the
whole design:

1. **`Transport` is a clean four-method interface** (`send`, `onMessage`, `onClose`, `onError`, `close`), so the
   package can ride DevDeck's existing authenticated socket instead of opening its own.
2. **Server→client requests get a blanket `null` reply.** `LanguageServerClient`'s notification hook answers any
   message with `data.method && data.id` by sending `{ result: null }`. Two problems: `workspace/configuration` —
   which gopls issues during initialisation — is specified to return an *array* with one entry per requested item,
   not `null`; and the truthiness check skips request `id: 0`, which would go unanswered entirely. Today's
   `respondToServer` returns the correct shapes, and that behaviour must be preserved.
3. **Cross-file navigation is computed then discarded.** `LanguageServerPlugin.requestLocation` returns
   `{ uri, range }` for any file but only dispatches a selection when `uri === this.documentUri`; the exported
   `jumpToDefinition` command ignores the return value. DevDeck's tab-opening navigation must stay custom.
4. **Rename applies only current-document edits.** `applyWorkspaceEdit` reads `edit.changes[plugin.documentUri]`
   and skips every `documentChanges` entry whose `textDocument.uri` differs. Using it as-is would rename a symbol
   in the open file and leave every other reference broken.

Peer dependency ranges (`@codemirror/autocomplete ^6.18.6`, `lint ^6.8.5`, `state ^6.5.2`, `view ^6.38.1`) are all
satisfied by the versions already in `frontend/package.json`. New transitive runtime dependencies: `marked ^16`
and `vscode-languageserver-protocol ^3.17.5`.

## Architecture

### Module layout

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/features/terminal/lspTransport.ts` | new | `Transport` implementation over `/ws/lsp`: control-frame demux, send queueing, server-request replies |
| `frontend/src/features/terminal/lspClient.ts` | rewrite | Ref-counted `LanguageServerClient` pool, uri↔path mapping, status subscription |
| `frontend/src/features/terminal/lspExtensions.ts` | new | Assembles CodeMirror extensions and the DevDeck overrides |
| `frontend/src/features/terminal/lspWorkspaceEdit.ts` | new | Pure `WorkspaceEdit` splitting and text-edit application |
| `frontend/src/features/terminal/lspRename.ts` | new | Rename command: prepare → prompt → confirm → apply |
| `frontend/src/features/terminal/RenameSymbolDialog.tsx` | new | Rename prompt + affected-files confirmation |
| `frontend/src/features/terminal/CodeFileEditor.tsx` | shrink | Drops hand-rolled completion source, diagnostics mapper, LSP definition branch |

Each unit is independently testable: the transport against a fake socket, the pool against a fake transport, the
workspace-edit module as pure functions, and the extensions against a real `EditorView` in jsdom.

### Transport

`DevDeckLspTransport` opens the socket via
`machineWsUrl(machine, '/lsp', { worktree: worktreeId, language })` and does three things the package's built-in
`WebSocketTransport` cannot:

- **Demultiplexes control frames.** Any message carrying a `devdeckLsp` key is consumed, converted to a status
  event (`connecting` → `installing` → `ready` | `error`), and never forwarded to the JSON-RPC layer. The `ready`
  frame resolves `transport.ready`, which yields the server-supplied `rootUri`.
- **Queues `send()` until the socket is open.** `JSONRPCClient` only awaits the `open` event when the transport is
  `instanceof WebSocketTransport`; for a custom transport its internal `ready` promise resolves immediately, so
  unqueued writes would throw `InvalidStateError`.
- **Answers server→client requests correctly.** Requests are recognised by having a `method` and an `id` that is
  neither `undefined` nor `null` (so `id: 0` counts). Replies match today's `respondToServer`:
  `workspace/configuration` → one `null` per requested item, `workspace/applyEdit` →
  `{ applied: false, failureReason: 'Workspace edits are not supported' }`, everything else (including
  `client/registerCapability` and `window/workDoneProgress/create`) → `null`. Because the transport answers these
  locally and does **not** forward them, the package's own blanket-`null` reply never fires, so there is no
  double response.

Server *notifications* (no `id`) pass through untouched so the package's `publishDiagnostics` handling works.

### Client pool

`acquireLspClient(machine, worktreeId, languageId)` keeps its current public shape — ref-counted by
`machineId:worktreeId:serverLanguage`, returning `{ client, release }` — but now:

1. Creates a `DevDeckLspTransport` and awaits `transport.ready` to learn `rootUri`.
2. Constructs `new LanguageServerClient({ transport, rootUri, workspaceFolders: [{ uri: rootUri, name: 'worktree' }], documentUri, languageId, autoClose: false, onError, onClose })`. `autoClose` stays false so the pool alone
   decides when to close the transport.
3. Exposes DevDeck-owned helpers that need `rootUri`: `documentUri(path)` (percent-encoded per segment) and
   `pathFromUri(uri)` (returns `null` for anything outside the root), carried over verbatim from today's client.
4. Exposes `subscribeStatus` / `getStatus` / `getStatusMessage`, backed by the transport's status events plus the
   client's `onError` / `onClose`.

`languageIdForPath` and `serverLanguage` are unchanged.

### Extension composition

`lspExtensions.ts` exports `lspExtensions({ pooled, path, onOpenDefinition, onRename })`, returning:

```
languageServerWithTransport({
  client, documentUri, languageId,
  allowHTMLContent: false,
  synchronizationMethod: SynchronizationMethod.Incremental,
})
```

This aggregate is the only way to obtain hover and document highlight — `hoverTooltip()` and `documentHighlight()`
are internal to the package and not exported. Three of its bundled extensions are then overridden at `Prec.high`,
which is safe because `languageServerPlugin` and the plugin's request methods are public:

- **Ctrl/Cmd-click and F12 → DevDeck navigation.** A `domEventHandlers` entry that returns `true`, so the
  package's own `mouseHandler` never runs and no duplicate request is issued. It calls
  `view.plugin(languageServerPlugin)?.requestDefinition(view, pos)`, maps the returned `uri` to a
  worktree-relative path, then either reveals the range in place or calls `onOpenDefinition(path, { symbol, range })`
  to open a tab. When the server returns nothing, today's regex/import-resolution fallback runs unchanged. The
  existing `event.preventDefault()` + `view.focus()` ordering is preserved — it is what stops a failed lookup from
  leaving the editor unfocused.
- **Autocomplete.** The package hardcodes `override: [lspSource]`, which would drop the `completeAnyWord`
  fallback. Replaced with `autocompletion({ override: [lspCompletionSource, completeAnyWord] })`, where
  `lspCompletionSource` delegates to `plugin.requestCompletion(...)` with the same trigger-character logic.
- **Diagnostics.** `syntaxDiagnostics` (the syntax-tree `linter()`) is **omitted whenever an LSP client is
  attached**. The package dispatches `setDiagnostics` directly rather than registering a linter source, and the two
  mechanisms overwrite each other, so keeping both would blink real diagnostics away on every keystroke. Files with
  no language server keep `syntaxDiagnostics` exactly as today.

Also added: `formattingOptions.of({ tabSize: 2, insertSpaces: true })`, a keymap binding `Shift-Alt-f` →
`formatDocument` and `Ctrl-k Ctrl-f` → `formatSelection`, and `F2` → DevDeck's rename command.

`devdeckCodeTheme` gains `.cm-lsp-highlight-text`, `.cm-lsp-highlight-read`, and `.cm-lsp-highlight-write` using
existing dark tokens. Hover tooltips inherit the existing `.cm-tooltip` rules.

### Rename

The package's `renameSymbol` is not used. DevDeck's command:

1. `client.textDocumentPrepareRename` → seed `RenameSymbolDialog` with the current symbol (falling back to
   `view.state.wordAt(pos)` when the server has no `prepareRename` provider).
2. `client.textDocumentRename` → `splitWorkspaceEdit(edit, documentUri, pathFromUri)` (pure, in
   `lspWorkspaceEdit.ts`) returns `{ currentEdits, otherFiles, unsupportedOps, outsideRoot }`, normalising both the
   `changes` map and the `documentChanges` array.
3. **Refusals, checked before anything is written:**
   - `unsupportedOps` non-empty (`create` / `rename` / `delete` file operations) → toast naming the operation,
     nothing applied.
   - `outsideRoot` non-empty (a uri that does not resolve inside the worktree) → toast, nothing applied.
   - Any *other* open tab with unsaved changes among `otherFiles` → toast naming the tab, nothing applied. A disk
     write must never clobber an unsaved buffer.
4. If `otherFiles` is non-empty, a confirmation dialog lists each path with its edit count. The current file is
   listed separately as "will stay unsaved".
5. On confirm: current-document edits are applied with a single `view.dispatch` (unsaved, undoable); each other
   file is read with `fetchWorktreeFile`, has its edits applied **back-to-front by offset** so earlier ranges stay
   valid, and is written with `writeWorktreeFile`. Then `qk.worktreeFile(machineId, worktreeId, path)` is
   invalidated per path plus `qk.worktreeFilesRoot(...)` once, so open tabs reload.
6. A write failure stops the loop and reports which files were already written — partial application is surfaced,
   never silently swallowed.

## Data Flow

```
CodeFileEditor mount
  └─ acquireLspClient(machine, worktreeId, languageId)
       ├─ DevDeckLspTransport  ──ws──▶  /ws/lsp  ──stdio──▶  gopls | tsserver | …
       │    ├─ devdeckLsp frames  ─▶ status listeners ─▶ toasts
       │    └─ server requests    ─▶ answered locally
       └─ LanguageServerClient.initialize()
            └─ languageServerPlugin (ViewPlugin)
                 ├─ didOpen / didChange (incremental)
                 ├─ publishDiagnostics ─▶ setDiagnostics
                 ├─ hover / completion / documentHighlight
                 └─ requestDefinition ─▶ DevDeck handler ─▶ onOpenDefinition (new tab)
```

## Error Handling

| Condition | Behaviour |
|---|---|
| `devdeckLsp: installing` | `toast.loading` with id `lsp-status-${worktreeId}-${languageId}`; upgraded to `toast.success` on `ready` (only if an install was seen) |
| `devdeckLsp: error` | `toast.error`; status `error`; editor falls back to `completeAnyWord` + regex definitions |
| Socket closes unexpectedly | `onClose` → status `error`; same fallback; no reconnect loop (matches today) |
| Request timeout | Package rejects after its own timeout; completion source returns `null`, definition falls through to the regex path |
| Definition outside worktree | `toast.error('Definition is outside this worktree')` — preserved from today |
| No language server for the file type | `languageIdForPath` returns `null`; no socket opened; `syntaxDiagnostics` + `completeAnyWord` only |

## Testing

Vitest (`npm test` in `frontend/`), jsdom environment.

- `lspTransport.test.ts` — control-frame demux never reaches the RPC layer; `ready` resolves with `rootUri`;
  `send` before `open` is queued and flushed in order; `workspace/configuration` receives one `null` per item;
  `workspace/applyEdit` is refused; notifications pass through; `close()` is idempotent.
- `lspClient.test.ts` — pool refcounting (shared instance, disposal on last release, no disposal while referenced);
  `documentUri` percent-encoding round-trips through `pathFromUri`; uris outside the root return `null`.
- `lspWorkspaceEdit.test.ts` — `changes` and `documentChanges` both normalise; unsupported file operations are
  reported not applied; out-of-root uris are reported; back-to-front application produces correct text for
  overlapping-adjacent and multi-line edits.
- `lspExtensions.test.ts` — against a real `EditorView` in jsdom with a fake plugin: completion falls back to
  `completeAnyWord` when the LSP source returns null; the DevDeck mousedown handler returns `true`.

Manual verification: hover on a Go symbol, Ctrl-click into another file, rename across two files, `Shift-Alt-f`
formatting, and the install-toast path with a language server absent from `PATH`.

## Out of Scope

- SSH files and untitled buffers (no worktree root, therefore no language server).
- Signature help, code actions, and find-references — the package exposes no client methods for them.
- Reconnect-on-drop; a closed socket requires reopening the tab, as today.
- Backend changes of any kind.
