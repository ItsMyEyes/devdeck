# Monaco Editor Migration — Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Replace CodeMirror with the Monaco editor across all six of DevDeck's editing surfaces, keep LSP
intelligence flowing from the runtime-side language servers over the existing `/ws/lsp` socket, add a
global "VS Code mode" toggle for full IDE chrome, then delete every CodeMirror module and drop the
packages.

## Superseded work

This design replaces `2026-08-02-codemirror-languageserver-design.md`, implemented in commits
`531fcf3`..`40ddb7a` on the same day. That work stays useful: the backend bridge, the `devdeckLsp`
control-frame protocol, the ref-counted session pool, the URI helpers and the workspace-edit splitter
were all designed against DevDeck's own constraints rather than against CodeMirror, and port to Monaco
essentially unchanged. What is discarded is the CodeMirror extension assembly in `lspExtensions.ts` and
the `codemirror-languageserver` package that forced four documented workarounds.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Migrate all six surfaces; remove CodeMirror packages | The stated goal is package removal, which is all-or-nothing — one remaining consumer keeps ~13 MB of `@codemirror`/`@lezer` in the tree |
| 2 | Monaco's **native** `lsp` client, not `monaco-languageclient` | Avoids 33.5 MB of `@codingame/monaco-vscode-api`, a version-locked monaco↔mlc↔codingame triple, and a VS Code service layer that would fight DevDeck's Tailwind theming and its own tab/pane system. Monaco 0.56 ships `MonacoLspClient` (144 KB) registering 21 providers |
| 3 | VS Code mode is one global localStorage pref | Matches the existing client-pref pattern (`paletteFrecency`, `ripgrepInstallPrefs`, `browserTileBookmarks`); server `Settings` is for server-side state |
| 4 | No Monaco built-in language workers | All intelligence comes from the runtime LSP. Shipping Monaco's TS worker alongside `typescript-language-server` would produce competing completions and duplicate diagnostics on the same buffer |
| 5 | Reach `MonacoLspClient` through a Vite alias | `lsp` is exported only from monaco's root entry, which eagerly registers the TypeScript language feature; that feature lazily pulls **12 MB** the moment a `.ts` model is created. The tree-shaken entries are therefore mandatory, and the client is imported by path |

### Monaco 0.56 findings

Verified against the installed `monaco-editor@0.56.0`. These drive the architecture:

1. **Monaco 0.55 added a native `lsp` namespace; 0.56 exposes typed client and transport APIs.**
   `MonacoLspClient`'s constructor takes a plain `IMessageTransport` (`send`, `setListener`, `state`) —
   the same shape of adaptation `DevDeckLspTransport` already performs for CodeMirror's `Transport`.
2. **`createFeatures()` registers 21 providers**: completion, hover, signature help, definition,
   declaration, type definition, implementation, references, document highlight, document symbol,
   rename, code action, code lens, document link, formatting, range formatting, on-type formatting,
   folding range, selection range, inlay hints, semantic tokens, diagnostics.
3. **It sends `rootUri: null`** and no `workspaceFolders`. gopls degrades to single-file mode without a
   root, so the outbound `initialize` must be rewritten in transit.
4. **It applies workspace edits only to loaded models**, so cross-file rename would silently drop edits
   to files that are not open — the same defect the superseded design documented.
5. **0.56 reorganised ESM into tree-shakeable entry points** (`monaco-editor/editor`,
   `features/register.all`, `languages/definitions/register.all`, `languages/features/register.all`).
   Language *definitions* are 1.4 MB of monarch tokenizers with no workers; language *features* are the
   workers, of which TypeScript alone is 12 MB behind a dynamic `import('./tsMode.js')` triggered by
   `languages.onLanguage('typescript')`.
6. **`monaco.editor.registerEditorOpener(opener: ICodeEditorOpener)` is public API** — the supported hook
   for opening a definition that resolves to a different file.

Findings 3 and 4 are both absorbed by the transport, which DevDeck owns. Finding 6 covers cross-file
navigation. Nothing requires patching monaco.

### Rejected

**`@monaco-editor/react` with the CDN loader.** DevDeck ships as a Tauri desktop app and runs on private
tunnels and offline machines. Monaco must be self-hosted and bundled by Vite.

**Importing monaco's root entry to get `lsp` legitimately.** It registers the TypeScript language
feature, which pulls 12 MB on the first `.ts` file opened — unacceptable over a tunnel.

**Hand-writing the provider bridge.** ~600 lines for ~6 providers, versus 144 KB for 21.

## Current state

### Backend — no changes required

`backend/internal/lsp/server.go` bridges `/ws/lsp?worktree=<id>&language=<lang>` to a real language
server process (gopls, typescript-language-server, pyright-langserver, rust-analyzer, jdtls),
auto-installing the binary when missing. Before any JSON-RPC traffic it writes control frames wrapped in
a `devdeckLsp` envelope:

| Type | Payload | Meaning |
|---|---|---|
| `installing` | `message`, `language` | Binary is being installed; may repeat |
| `ready` | `language`, `rootUri` | Server process is live; `rootUri` is the resolved worktree root |
| `error` | `message` | Fatal; socket closes with `StatusPolicyViolation` |

This protocol is unchanged by the migration. The socket is authenticated and machine-scoped, which is why
Monaco must be handed an already-open socket rather than a URL.

### Frontend — the CodeMirror surface

| Feature | Files | LOC |
|---|---|---|
| Worktree code editor (LSP) | `CodeFileEditor.tsx`, `lspExtensions.ts`, `lspSession.ts`, `lspTransport.ts`, `lspRename.ts` | ~1,500 |
| SSH / untitled buffers | `PlainCodeEditor.tsx` | 126 |
| Markdown | `MarkdownFileEditor.tsx` | 286 |
| Database SQL | `DBSqlEditor.tsx`, `sqlEditorSupport.ts` | 558 |
| Agent management | `EnvSettingsEditor.tsx`, `SkillContentDialog.tsx` | 472 |

Bundle today: 5.4 MB JS across 241 chunks; the `CodeFileEditor` chunk is 208 KB, plus ~150 lazily loaded
language-mode chunks from `@codemirror/language-data`.

### The boundary problem this migration fixes

`CodeFileEditor.tsx` is both the largest editor *and* the shared toolkit — it exports `devdeckCodeTheme`,
`explicitHistoryKeymap`, `syntaxDiagnostics` and `useFileLanguage`, which `MarkdownFileEditor` and
`PlainCodeEditor` import. The SSH editor therefore transitively depends on the worktree LSP editor. The
new layout separates the shared kit from the LSP-aware surface.

## Architecture

### New — `frontend/src/features/editor/` (shared, no LSP knowledge)

| File | Responsibility |
|---|---|
| `monacoSetup.ts` | One-time init. Imports `monaco-editor/editor` + `features/register.all` + `languages/definitions/register.all` and **never** `languages/features/*`; wires `MonacoEnvironment.getWorker` to the single default editor worker; registers the `devdeck-dark` theme. Exports the `monaco` namespace so no other module imports it directly |
| `MonacoEditor.tsx` | The single React wrapper — `value` / `onChange` / `path` / `reveal` / `readOnly` / model lifecycle |
| `editorTheme.ts` | `devdeck-dark` Monaco theme built from the `globals.css` tokens, replacing `oneDark` + `devdeckCodeTheme` |
| `editorOptions.ts` | Pure `(vscodeMode: boolean, overrides) => IStandaloneEditorConstructionOptions` |
| `useVsCodeMode.ts` | Reads/writes the `devdeck.editor.vscodeMode` localStorage pref, subscribable so open editors react live |
| `modelRegistry.ts` | Module-level `ITextModel` cache keyed by `machine:worktree:path` |
| `reveal.ts` | `LineReveal` / range reveal → `setSelection` + `revealRangeInCenter` |
| `languageForPath.ts` | Path → Monaco language id, replacing `useFileLanguage`'s `LanguageDescription.matchFilename` |

### New — `frontend/src/features/terminal/lsp/` (the bridge)

| File | Fate | Notes |
|---|---|---|
| `lspTransport.ts` | **Ported + extended** | Reshaped from CodeMirror's `Transport` to monaco's `IMessageTransport`. The `devdeckLsp` envelope handling, the send queue, the `workspace/configuration` array reply and the `id: 0` guard all stay. Gains three responsibilities: `initialize` rewriting, a `request()` channel, and a `state` value |
| `lspSession.ts` | **Ported** | `uriHelpers`, `languageIdForPath`, `serverLanguage` and `createLspSessionPool` unchanged; `LanguageServerClient` swaps for `MonacoLspClient` |
| `lspWorkspaceEdit.ts` | **Ported verbatim** | Already pure |
| `lspRename.ts` | **Ported** | Plan-building is pure and unchanged; the apply step retargets to Monaco models + `writeWorktreeFile` |
| `definitionFallback.ts` | **New (extracted)** | `findDefinition`, `findImportedSource`, `quotedPathAt`, `resolveImportBase`, `resolveImportFile` lifted out of `CodeFileEditor.tsx` unchanged — they operate on strings, not editor state |
| `editorOpener.ts` | **New** | `monaco.editor.registerEditorOpener` → DevDeck tab open, replacing the discarded cross-file navigation |
| `lspExtensions.ts` | **Deleted** | CodeMirror extension assembly, wholly replaced by `MonacoLspClient` |
| `lspClient.ts`, `monacoProviders.ts` | **Not needed** | `MonacoLspClient` supplies both |

### `DevDeckLspTransport` responsibilities

The transport is where every DevDeck-specific deviation lives, which keeps `MonacoLspClient` unpatched
and keeps all of it unit-testable without mounting an editor:

1. Consume `devdeckLsp` control frames → status events *(existing)*
2. Answer `workspace/configuration` with a correctly shaped array, and `workspace/applyEdit` with
   `{applied:false}`; guard `id: 0` *(existing)*
3. Queue sends until `socket.readyState === OPEN` *(existing)*
4. Rewrite the outbound `initialize` request, injecting `rootUri` and `workspaceFolders` from the
   backend's `ready` frame *(new — works around finding 3)*
5. Expose `request(method, params)` on a private id range so DevDeck's rename and definition flows can
   talk to the server alongside `MonacoLspClient` on the same socket *(new — works around finding 4)*
6. Expose `state: IValueWithChangeEvent<ConnectionState>` as monaco's interface requires *(new)*

Private request ids are strings prefixed `devdeck-`, so they cannot collide with the numeric ids
`MonacoLspClient` allocates; responses carrying such an id are resolved locally and never forwarded.

### The model registry is load-bearing

`sshTerminalRegistry.ts` already keeps xterm sessions outside React because `PaneCanvas` remounts a leaf
on every drag-to-split — `moveTab` always allocates a fresh leaf id. The same remount hits editors.

If a Monaco **model** is destroyed and recreated on a pane move, the LSP `didOpen`/`didChange` version
counter resets with no matching `didClose` — precisely the desync `CodeFileEditor.tsx:568-580` documents
today. Keeping models in a module-level registry means a pane restructure recreates only the cheap editor
*instance* and reattaches the same model, preserving undo history and LSP version continuity. It also
gives cross-file rename somewhere to edit background files that are not currently on screen.

Registry contract:

- `acquireModel(key, uri, value, languageId)` → `ITextModel`, created on miss, ref-counted
- `releaseModel(key)` → decrements; disposes and fires `didClose` at zero
- A tab close releases; a pane move does not

## Data flow — LSP

```
CodeFileEditor
  └─ acquireLspSession(machine, worktreeId, languageId)      [ported, ref-counted pool]
       └─ openLspTransport → machineWsUrl('/lsp', {worktree, language})
            └─ DevDeckLspTransport(socket)  implements monaco.lsp.IMessageTransport
                 ├─ consumes devdeckLsp control frames → status events
                 ├─ rewrites outbound `initialize` → injects rootUri + workspaceFolders
                 ├─ answers workspace/configuration + workspace/applyEdit itself
                 ├─ resolves `devdeck-*` ids locally, forwards everything else
                 └─ queues sends until socket.readyState === OPEN
       └─ new MonacoLspClient(transport)
            └─ registers 21 providers + textDocument sync, globally per language id
       └─ registerEditorOpener(...)        → cross-file definition opens a DevDeck tab
       └─ editor.addAction('devdeck.rename', F2)
            └─ transport.request('textDocument/rename') → buildRenamePlan
                 → RenameSymbolDialog → applyRenamePlan
```

`MonacoLspClient` registers providers **globally, once per session** — monaco's provider registry is
keyed by language, not by editor. Constructing one client per editor instance would fan out duplicate
completions across split panes, so construction is owned by the ref-counted session pool, which already
guarantees one session per `machine:worktree:language`.

### Behaviour that must survive

These are DevDeck-specific and not provided by any package:

1. **Cross-file go-to-definition.** A definition resolving to another file opens a tab rather than being
   discarded. `monaco.editor.registerEditorOpener` is the supported hook: monaco calls `openCodeEditor`
   with the target `Uri` and range, DevDeck maps the uri back to a worktree path via the session's
   `pathFromUri`, opens the tab, and returns `true` to claim the navigation.
2. **Regex/import fallback.** With no language server, `findDefinition`, `findImportedSource`,
   `quotedPathAt` and `resolveImportFile` remain the whole go-to-definition feature. Extracted to
   `definitionFallback.ts` unchanged — they operate on strings, not on editor state.
3. **Cross-file rename.** `buildRenamePlan` splits a `WorkspaceEdit` into current-file and other-file
   edits, refuses when a target file has unsaved changes (`isPathDirty`), and renders
   `RenameSymbolDialog` for confirmation. `MonacoLspClient`'s own rename feature applies edits only to
   loaded models, so DevDeck registers an `editor.addAction` bound to F2 whose keybinding takes
   precedence over the built-in `editor.action.rename`, and drives the existing plan/dialog/apply
   pipeline through `transport.request`.
4. **LSP status toasts.** `installing` → loading toast, `ready` after installing → success, `error` →
   error toast, keyed `lsp-status-<worktreeId>-<languageId>`.
5. **Reveal-on-open.** Search results and definition jumps scroll to and select a range. The existing
   one-way `ready` latch is preserved — see below.

### The reveal latch must be preserved

`CodeFileEditor.tsx:629-652` documents a bug worth not reintroducing: the reveal effect depends on
`[reveal, ready]`, **not** `[reveal, value]`. `ready` flips false→true exactly once when real content
loads; `value` changes on every keystroke. Depending on `value` re-selected the revealed range after
every edit, snapping the cursor back and making it look like only that location was editable.

`viewReady` exists for the same reason — `@uiw/react-codemirror` creates its view across two render
passes. Monaco has the same property: `editor.onDidCreateEditor` / the wrapper's mount callback is the
only reliable signal that an instance exists. The Monaco port keeps both the `ready` latch and the
mounted-instance latch.

## VS Code mode

A single switch in Desktop Settings → Editor, persisted to `localStorage` under
`devdeck.editor.vscodeMode`, applied to every editor surface.

| Option | ON | OFF |
|---|---|---|
| `minimap.enabled` | `true` | `false` |
| `stickyScroll.enabled` | `true` | `false` |
| `folding` | `true` | `false` |
| `breadcrumbs` | rendered by `MonacoEditor` | hidden |
| `lineNumbers` | `'on'` | `'on'` |
| `renderLineHighlight` | `'all'` | `'line'` |
| `matchBrackets` | `'always'` | `'near'` |
| `occurrencesHighlight` | `'singleFile'` | `'off'` |
| `glyphMargin` | `true` | `false` |
| `scrollbar.vertical` | `'auto'` | `'auto'` |

Breadcrumbs are not a Monaco standalone feature — they are workbench UI. `MonacoEditor.tsx` renders its
own breadcrumb strip from the file path, styled with the existing `devdeck-*` tokens, shown only in VS
Code mode. It is display-only; clicking a segment is out of scope.

`editorOptions.ts` is a pure function so the mapping is unit-testable without mounting an editor.

Changing the toggle applies to already-open editors: `useVsCodeMode` publishes to subscribers and each
mounted `MonacoEditor` calls `editor.updateOptions()`. No reload, no remount, no lost undo history.

## Per-surface migration

| Surface | Today | After |
|---|---|---|
| `CodeFileEditor.tsx` | 700 lines: CodeMirror + LSP + navigation + rename | ~300 lines: `MonacoEditor` + session/provider wiring + rename dialog. Navigation heuristics move to `definitionFallback.ts` |
| `PlainCodeEditor.tsx` | CodeMirror + `completeAnyWord` + `lintGutter` | `MonacoEditor`, word-based suggestions on, no LSP. Keeps `LineReveal` |
| `MarkdownFileEditor.tsx` | CodeMirror + preview split + toolbar + slash commands | `MonacoEditor` (`wordWrap: 'on'`) + unchanged preview/toolbar/`SLASH_COMMANDS` |
| `DBSqlEditor.tsx` | `@codemirror/lang-sql` with schema-aware completion | `MonacoEditor` (`language: 'sql'`) + a Monaco `CompletionItemProvider` fed by the **unchanged** `buildSQLSchema` |
| `EnvSettingsEditor.tsx` | `@codemirror/lang-json` + `jsonParseLinter` | `MonacoEditor` + a hand-written JSON parse check via `setModelMarkers` (Monaco's JSON worker is disabled per decision 4) |
| `SkillContentDialog.tsx` | CodeMirror, `EditorView.editable` toggle | `MonacoEditor` with `readOnly` prop |

`sqlEditorSupport.ts` imports nothing from CodeMirror — only a comment references `SQLNamespace`. It
ports unchanged and its 204-line test suite stays green; only the comment is corrected.

`EnvSettingsEditor`'s linter is the one genuine capability loss from decision 4. `jsonParseLinter`
becomes a `JSON.parse` in a try/catch that maps the thrown position to a marker range — adequate for a
settings file, and it keeps the TS worker out of the bundle.

## Error handling

- **Socket failure / server unavailable.** `DevDeckLspTransport` already resolves this: status goes
  `error`, `ready` rejects, the pool deletes the entry so the next acquire retries. The editor falls back
  to the regex/import definition heuristics. Ported unchanged.
- **Provider request failure.** Every provider call is wrapped; a rejected LSP request returns an empty
  result rather than surfacing a Monaco exception. A failed *definition* falls through to the regex
  fallback; a failed *rename* toasts and closes the dialog.
- **Model/editor lifecycle.** Disposing an editor never disposes its model — only `releaseModel` at
  refcount zero does. Guards against the "dispose on pane move" desync described above.
- **Worker load failure.** If Monaco's editor worker fails to load, the editor still renders and edits;
  only tokenization-adjacent features degrade. Logged once, not toasted per file.
- **`isPathDirty` refusal.** Unchanged: a cross-file rename touching a file with unsaved changes refuses
  with a toast rather than overwriting.

## Testing

TDD throughout. New Vitest files are added to the `include` list in `vite.config.ts` as they land — the
repo's convention, since ~20 legacy `check()`-harness files would otherwise break `npm test`.

| Test | Covers |
|---|---|
| `editorOptions.test.ts` | Pure `vscodeMode` → options mapping, both directions |
| `useVsCodeMode.test.ts` | localStorage read/write, malformed value, subscriber fan-out |
| `modelRegistry.test.ts` | Ref-count acquire/release, no dispose while referenced, dispose at zero, reattach after remount |
| `languageForPath.test.ts` | Extension → Monaco language id, unknown → `plaintext` |
| `lspTransport.test.ts` | **Exists — must stay green.** Control frames, send queue, `id: 0`, `workspace/configuration` shape |
| `lspSession.test.ts` | **Exists — must stay green.** Pool ref-counting, URI helpers |
| `lspWorkspaceEdit.test.ts` | **Exists — must stay green.** Already pure |
| `lspTransport.initialize.test.ts` | New: outbound `initialize` gains `rootUri` + `workspaceFolders`; other messages pass through untouched |
| `lspTransport.request.test.ts` | New: `devdeck-*` ids resolve locally and are never forwarded to the client listener; foreign responses are forwarded; pending requests reject on close |
| `monacoLspClient.guard.test.ts` | New: asserts the `monaco-lsp-client` alias resolves and exports `MonacoLspClient` — fails loudly if a monaco upgrade moves the file |
| `editorOpener.test.ts` | New: uri → worktree path mapping, returns `true` only for in-worktree uris |
| `definitionFallback.test.ts` | Ported heuristics: `findDefinition`, `findImportedSource`, `quotedPathAt`, `resolveImportBase` |
| `sqlCompletion.test.ts` | `SQLSchemaMap` → Monaco completion items |
| `sqlEditorSupport.test.ts` | **Exists — must stay green, unchanged** |
| `lspExtensions.test.ts` | **Deleted** with the module it pins |

Transport tests run against a fake `WebSocket` rather than a live socket, following the existing
`lspTransport.test.ts` pattern. No test mounts a Monaco editor: monaco needs `matchMedia`,
`ResizeObserver` and real layout that jsdom does not provide, so every unit under test is either pure or
takes monaco's namespace as an injected argument.

Verification gates: `npm run typecheck`, `npm test`, `npm run build`, `go vet ./...`.

## Deletion and package removal

Removed from `frontend/package.json`:

```
@codemirror/autocomplete   @codemirror/commands    @codemirror/lang-sql
@codemirror/language       @codemirror/language-data  @codemirror/lint
@codemirror/state          @codemirror/theme-one-dark @codemirror/view
@uiw/react-codemirror      codemirror-languageserver
```

`vscode-languageserver-protocol` **stays** — it supplies the LSP types the transport and rename flow use.

Added: `monaco-editor@^0.56.0` only. `vscode-jsonrpc` is **not** needed — `MonacoLspClient` brings its own
JSON-RPC layer, and the transport speaks raw JSON-RPC objects.

`vite.config.ts` gains one alias:

```ts
'monaco-lsp-client': fileURLToPath(
  new URL('./node_modules/monaco-editor/esm/external/monaco-lsp-client/out/index.js', import.meta.url),
)
```

Monaco is pinned to `^0.56.0`. The alias reaches past the package's `exports` map, which stops at
`esm/vs/*`; `monacoLspClient.guard.test.ts` pins it so an upgrade that relocates the file fails a test
rather than a user's editor.

Deleted files: `lspExtensions.ts`, `lspExtensions.test.ts`.

Removal is the **final** step. Deleting packages before every surface migrates leaves the tree
uncompilable, so the order is: shared kit → surfaces → LSP bridge → `CodeFileEditor` → settings toggle →
delete and remove.

Done means `rg -i 'codemirror|@uiw|@lezer'` over `frontend/src` returns nothing, `frontend/package.json`
lists none of the above, and `npm run build` succeeds.

## Risks

| Risk | Mitigation |
|---|---|
| Bundle grows over a tunnel deployment | Decisions 4 and 5 keep out the 12 MB TypeScript feature, by far the largest asset. `MonacoEditor` stays behind the existing `lazy()` boundaries in `FileEditor.tsx` / `SSHFileEditor.tsx`. Baseline before the migration is **5.4 MB JS across 241 chunks**; measure again after and report the delta |
| A monaco upgrade relocates the aliased LSP client | Pinned to `^0.56.0` and covered by `monacoLspClient.guard.test.ts`, which fails in CI rather than at runtime |
| `MonacoLspClient` is opaque — no public hook to disable individual features | Every deviation is handled in the transport or by overriding a keybinding, so the client is never patched or subclassed. If a future need cannot be met that way, the fallback is the hand-written bridge, which this design deliberately keeps possible by keeping all LSP types in `vscode-languageserver-protocol` |
| Monaco instances are heavier than CodeMirror per pane | Model registry shares models across remounts; only the instance is recreated |
| Losing a behaviour documented only in a code comment | The five items under "Behaviour that must survive" and the reveal-latch section are pinned by tests before their modules are touched |
| Scope: six surfaces plus a bridge is a large change | Sequenced so the tree typechecks at every step; CodeMirror is removed only at the end |

## Out of scope

- Backend changes of any kind
- Clickable breadcrumb navigation
- Adding language servers beyond the five the backend already installs
- Monaco's diff editor, and a VS Code-style command palette (the app has its own)
- Migrating the ~20 legacy `check()`-harness test files
