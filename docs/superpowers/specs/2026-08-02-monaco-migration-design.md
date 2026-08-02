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
| 2 | Thin LSP bridge, not `monaco-languageclient` | Avoids 33.5 MB of `@codingame/monaco-vscode-api`, a version-locked monaco↔mlc↔codingame triple, and a VS Code service layer that would fight DevDeck's Tailwind theming and its own tab/pane system |
| 3 | VS Code mode is one global localStorage pref | Matches the existing client-pref pattern (`paletteFrecency`, `ripgrepInstallPrefs`, `browserTileBookmarks`); server `Settings` is for server-side state |
| 4 | No Monaco built-in language workers | All intelligence comes from the runtime LSP. Shipping Monaco's TS worker alongside `typescript-language-server` would produce competing completions and duplicate diagnostics on the same buffer |

### Rejected

**`@monaco-editor/react` with the CDN loader.** DevDeck ships as a Tauri desktop app and runs on private
tunnels and offline machines. Monaco must be self-hosted and bundled by Vite.

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
| `monacoSetup.ts` | One-time init: Vite `?worker` wiring, `devdeck-dark` theme registration, built-in TS/JSON/CSS/HTML language services disabled |
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
| `lspTransport.ts` | **Ported** | Only `implements Transport` drops. The `devdeckLsp` envelope handling, the send queue, the `workspace/configuration` array reply and the `id: 0` guard all stay exactly as written |
| `lspSession.ts` | **Ported** | `uriHelpers`, `languageIdForPath`, `serverLanguage` and `createLspSessionPool` unchanged; only `LanguageServerClient` swaps for the new client |
| `lspClient.ts` | **New** | `vscode-jsonrpc` `MessageConnection` over the transport: `initialize`, `didOpen`/`didChange`/`didClose`, typed request helpers, `publishDiagnostics` fan-out |
| `monacoProviders.ts` | **New** | Registers completion, hover, definition, rename and formatting providers; diagnostics via `setModelMarkers` |
| `lspWorkspaceEdit.ts` | **Ported verbatim** | Already pure |
| `lspRename.ts` | **Ported** | Plan-building is pure and unchanged; only the apply step retargets to Monaco models |
| `lspExtensions.ts` | **Deleted** | Its content is CodeMirror extension assembly; the DevDeck-specific behaviour moves into `monacoProviders.ts` |

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
            └─ DevDeckLspTransport(socket)                    [ported]
                 ├─ consumes devdeckLsp control frames → status events
                 ├─ answers workspace/configuration + workspace/applyEdit itself
                 └─ queues sends until socket.readyState === OPEN
       └─ createLspClient(transport)                          [new]
            └─ vscode-jsonrpc MessageConnection
                 ├─ initialize / initialized
                 ├─ didOpen / didChange (incremental) / didClose
                 └─ publishDiagnostics → setModelMarkers
       └─ registerProviders(session, monaco)                  [new]
            ├─ CompletionItemProvider    → textDocument/completion
            ├─ HoverProvider             → textDocument/hover
            ├─ DefinitionProvider        → textDocument/definition
            ├─ RenameProvider            → prepareRename + buildRenamePlan
            └─ DocumentFormattingProvider→ textDocument/formatting
```

Providers are registered **per language id, once per session**, and dispose with the session. Registering
per editor instance would fan out duplicate completions across split panes.

### Behaviour that must survive

These are DevDeck-specific and not provided by any package:

1. **Cross-file go-to-definition.** A definition resolving to another file opens a tab via
   `onOpenDefinition` rather than being discarded. Monaco's default `DefinitionProvider` only navigates
   within the current model, so the `editor.gotoLocation` action is intercepted.
2. **Regex/import fallback.** With no language server, `findDefinition`, `findImportedSource`,
   `quotedPathAt` and `resolveImportFile` remain the whole go-to-definition feature. Ported as-is —
   they operate on strings, not on CodeMirror state.
3. **Cross-file rename.** `buildRenamePlan` splits a `WorkspaceEdit` into current-file and other-file
   edits, refuses when a target file has unsaved changes (`isPathDirty`), and renders
   `RenameSymbolDialog` for confirmation. Monaco's `RenameProvider` returns only a `WorkspaceEdit`, so
   the dialog flow stays custom and the provider is a thin entry point into it.
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
| `lspClient.test.ts` | New: initialize handshake, didChange versioning, diagnostics fan-out, request rejection |
| `monacoProviders.test.ts` | New: LSP↔Monaco type translation (completion kinds, ranges, markers) against a fake session |
| `definitionFallback.test.ts` | Ported heuristics: `findDefinition`, `findImportedSource`, `quotedPathAt`, `resolveImportBase` |
| `sqlCompletion.test.ts` | `SQLSchemaMap` → Monaco completion items |
| `sqlEditorSupport.test.ts` | **Exists — must stay green, unchanged** |
| `lspExtensions.test.ts` | **Deleted** with the module it pins |

`monacoProviders` and `lspClient` are tested against a fake session/transport rather than a live socket,
following the existing `lspExtensions.test.ts` `fakeSession` pattern.

Verification gates: `npm run typecheck`, `npm test`, `npm run build`, `go vet ./...`.

## Deletion and package removal

Removed from `frontend/package.json`:

```
@codemirror/autocomplete   @codemirror/commands    @codemirror/lang-sql
@codemirror/language       @codemirror/language-data  @codemirror/lint
@codemirror/state          @codemirror/theme-one-dark @codemirror/view
@uiw/react-codemirror      codemirror-languageserver
```

`vscode-languageserver-protocol` **stays** — it supplies the LSP types the bridge uses.

Added: `monaco-editor`, `vscode-jsonrpc`.

Deleted files: `lspExtensions.ts`, `lspExtensions.test.ts`.

Removal is the **final** step. Deleting packages before every surface migrates leaves the tree
uncompilable, so the order is: shared kit → surfaces → LSP bridge → `CodeFileEditor` → settings toggle →
delete and remove.

Done means `rg -i 'codemirror|@uiw|@lezer'` over `frontend/src` returns nothing, `frontend/package.json`
lists none of the above, and `npm run build` succeeds.

## Risks

| Risk | Mitigation |
|---|---|
| Bundle grows over a tunnel deployment | Decision 4 drops the TS worker, the single largest asset. `MonacoEditor` stays behind the existing `lazy()` boundaries in `FileEditor.tsx` / `SSHFileEditor.tsx`. Measure `npm run build` before and after; report the delta |
| Monaco instances are heavier than CodeMirror per pane | Model registry shares models across remounts; only the instance is recreated |
| Losing a behaviour documented only in a code comment | The five items under "Behaviour that must survive" and the reveal-latch section are pinned by tests before their modules are touched |
| Scope: six surfaces plus a bridge is a large change | Sequenced so the tree typechecks at every step; CodeMirror is removed only at the end |

## Out of scope

- Backend changes of any kind
- Clickable breadcrumb navigation
- Adding language servers beyond the five the backend already installs
- Monaco's diff editor, and a VS Code-style command palette (the app has its own)
- Migrating the ~20 legacy `check()`-harness test files
