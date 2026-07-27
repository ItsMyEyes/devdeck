# LSP Editor Intelligence — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorming complete)

## Goal

The worktree code editor has a working LSP bridge but the editing experience
around it is broken or missing. This project fixes two bugs that make the
editor actively unpleasant, then adds three features that make its language
intelligence match what people expect from VS Code: a peek-references panel,
semantic colouring, and a real unsaved-changes dialog.

Five items, delivered in two batches.

## Prior fix this builds on

The LSP WebSocket previously negotiated `permessage-deflate`, which WebKit
(the Tauri desktop app's WKWebView, iOS Safari) kills with a protocol-error
close frame the moment real traffic flows. Fixed in `internal/lsp/server.go`
by moving to `CompressionDisabled`, matching the terminal and SSH sockets.
Every LSP feature below depends on that fix being deployed — a stale sidecar
binary will make all of them appear broken.

## Measured facts

All measured against gopls v0.22.0 over the real `/ws/lsp` endpoint from a
WebKit client, not assumed:

| Question | Answer |
|---|---|
| `referencesProvider` | `true`; returns `Location[]` (uri + range) |
| Completion trigger characters | `["."]` |
| Completions after `cli.` | 37 items, incl. `ExecuteRootCmd` (kind 3 = function) |
| `semanticTokensProvider` by default | **absent**; `semanticTokens/full` returns 0 tokens |
| With `initializationOptions: {semanticTokens: true}` | full legend (15 types, 17 modifiers), real token data |
| Cold definition round-trip on a large repo | **~12s**, against a 15s client timeout |

Two consequences worth stating plainly:

- gopls ships with semantic tokens **off**. The `workspace/configuration`
  handler answers `null` for every section, so the settings route cannot turn
  them on. It has to be `initializationOptions`.
- The 12s cold round-trip leaves ~3s of headroom against the current 15s
  timeout. A larger repo blows through it and surfaces as a misleading
  "not found".

## Decisions (from brainstorming)

1. **References trigger: VS Code semantics.** Cmd-click still jumps to
   definition. When the definition resolves to the click site itself (you are
   already at the definition), open the references peek instead. Nothing about
   today's jump behaviour changes.
2. **References UI: inline peek**, a CodeMirror block widget under the clicked
   line — not a bottom panel, not a popover.
3. **Sequencing: bugs first.** Batch 1 (typing, autocomplete) ships before
   Batch 2 (save dialog, semantic colours, references).
4. **Colouring means semantic tokens in the code**, not popup or panel
   colouring. Identifiers the language server actually resolves get their real
   kind colour; unresolved names keep plain syntax colouring.
5. **Vitest lands first.** `COMMANDS.md` names Vitest as the intended choice
   and 12 `.test.ts` files already exist in `frontend/src` with no runner and
   no `test` script. They cannot execute today.

## Batch 1 — Bugs

### #2 Reveal effect re-fires on every keystroke

**Symptom:** in a file opened via Cmd-click or a content-search result, typing
only ever edits one word.

**Root cause:** `CodeFileEditor.tsx:686-694`.

```ts
useEffect(() => {
  const view = editorRef.current?.view
  if (!view || !reveal) return
  if (reveal.range) revealRange(view, reveal.range)
  else if (reveal.symbol) revealDefinition(view, value, reveal.symbol)
}, [reveal, value])
```

`reveal` is set when the file is opened by navigation and is never cleared.
`value` is a dependency, so every keystroke re-dispatches the selection and
calls `view.focus()` — snapping the cursor back and re-selecting the original
symbol, so the next character overwrites it. `DefinitionReveal.requestId`
exists for exactly this purpose and nothing reads it.

**Fix:** apply each reveal once, keyed by `requestId`.

```ts
const appliedReveal = useRef(-1)
useEffect(() => {
  const view = editorRef.current?.view
  if (!view || !reveal || !value) return
  if (appliedReveal.current === reveal.requestId) return
  appliedReveal.current = reveal.requestId
  if (reveal.range) revealRange(view, reveal.range)
  else if (reveal.symbol) revealDefinition(view, value, reveal.symbol)
}, [reveal, value])
```

`value` stays in the dependency array deliberately. `FileEditor` initialises
`draft` to `''` and fills it when the file query resolves, so a
jump-to-open file has an empty document on first render; dropping `value`
would silently break reveal-on-open. The `requestId` guard stops the repeat,
the `!value` check preserves the retry, and a fresh jump to the same file
gets a new `requestId` and fires again.

### #4 Autocomplete

Two independent causes.

**Cause A — dead socket.** Already fixed by the compression change. Requires a
sidecar rebuild to observe. `lspCompletionSource` swallows the failure
(`catch { return null }`) and silently degrades to `completeAnyWord`, which is
why it looked like "autocomplete does nothing" rather than an error.

**Cause B — member completion is never requested.** `CodeFileEditor.tsx:422`:

```ts
const word = context.matchBefore(/[A-Za-z_$][\w$]*$/)
if (!context.explicit && (!word || word.from === word.to)) return null
```

After typing `cli.` there is no word prefix, so the source bails before
issuing a request. gopls advertises `.` as a trigger character and returns 37
completions for that exact position, so the data is there and never asked for.

**Fix:**

1. `LspClient` reads `capabilities.completionProvider.triggerCharacters` from
   the initialize result (today only `textDocumentSync` is read) and exposes
   it via `getTriggerCharacters()`.
2. `lspCompletionSource` also fires when the character before the cursor is a
   trigger character, sending `context: { triggerKind: 2, triggerCharacter }`
   instead of `triggerKind: 1`. With no word prefix, `from` is `context.pos`.

## Batch 2 — Features

### #3 Save / Don't Save / Cancel on close

**Today:** `ExpandedTerminal.tsx:320` uses `window.confirm("Close X without
saving?")` — two buttons, no way to save. `handleClosePane` (:342) has the
same problem for multi-file panes.

**Design:** saving lives in `FileEditor` (it owns `draft` and
`useWriteWorktreeFile`); closing lives in `ExpandedTerminal`. Bridge them the
same way dirty state is already bridged:

- `FileEditor` gains `onRegisterSave(path, fn)`, registering a
  `() => Promise<boolean>` saver in an effect and unregistering on unmount.
  `ExpandedTerminal` holds these in a `useRef<Map<string, Saver>>`, mirroring
  the existing `onDirtyChange` pattern.
- `handleCloseTab` sets `pendingClose` state instead of calling `confirm`.
  A dialog built on the existing `@/components/ui/dialog` offers **Save**,
  **Don't Save**, **Cancel**. Save runs the registered saver and closes only
  on success; Don't Save closes and discards; Cancel aborts.
- `handleClosePane` reuses the same dialog with a plural message and a
  **Save all** action, so the two paths stay consistent.
- The existing `beforeunload` guard is unchanged.

### #5 Semantic colouring

- Send `initializationOptions` per server language. Only gopls needs
  `{ semanticTokens: true }`; typescript-language-server and rust-analyzer
  provide tokens by default. Keyed off `serverLanguage(languageId)`.
- Read `capabilities.semanticTokensProvider.legend` from the initialize
  result and keep it on the client.
- Add `client.semanticTokens(path)` issuing `textDocument/semanticTokens/full`.
- Decode the relative-encoded `[Δline, Δchar, length, tokenType, modifiers]`
  quintuples into absolute positions. This is a pure function and the natural
  unit-test target.
- Apply as `Decoration.mark({ class })` through a `StateField` fed by a
  `StateEffect`, at higher precedence than oneDark's syntax highlighting.
  Classes are themed in `devdeckCodeTheme` (dark-only, per project rules).
- Refresh after `didOpen` and on a ~300ms debounce after `didChange`.

Identifiers the server does not resolve simply receive no token and keep their
plain syntax colour — that difference is the feature.

### #1 References peek panel

**Trigger.** In the existing mousedown handler, `definition()` runs as today.
If the resolved definition is in the current file and its range contains the
clicked position, treat it as a self-jump: issue `textDocument/references`
(`includeDeclaration: true`) and open the peek instead of navigating.

**Rendering.** A `Decoration.widget({ block: true, side: 1 })` at the end of
the clicked line, whose `toDOM()` returns a container that React content is
portaled into. Layout matches the reference screenshot: header with filename,
directory and `References (N)`; left source preview; right clickable list
grouped by file.

The left preview reuses ContentSearchPanel's existing line rendering rather
than nesting a second CodeMirror instance inside the editor — same visual
result, far less weight. File contents for previewed files are fetched on
demand and cached for the life of the panel.

**Interactions.** Row click updates the preview; Enter or double-click routes
through the existing `onOpenDefinition` (which already opens a tab and reveals
a range); Esc or the close button dismisses.

**Degenerate results.** If `references` returns only the declaration itself,
or nothing at all, no panel opens — a toast reports that the symbol has no
other references. If the symbol has no definition at all, behaviour is
unchanged from today: the existing `openFallback` path runs.

### Cross-cutting: pending and initialising feedback

- Cmd-click while LSP status is `connecting` or `installing` shows
  `toast.loading('Language server is starting…')` under a stable toast id,
  dismissed when the request resolves. The request still proceeds; it is
  queued behind `ready`.
- A references request in flight opens the panel immediately in a
  "Finding references…" state rather than blocking on a silent await.
- **Raise the LSP request timeout from 15s to 30s** (`lspClient.ts:529`).
  A cold gopls measured 12s on a real repo; 15s is not enough headroom, and
  the timeout surfaces as a misleading "not found".

## Architecture summary

Entirely frontend. The Go LSP bridge is a transparent JSON-RPC passthrough and
needs **no changes** for any of the five items.

| File | Change |
|---|---|
| `lspClient.ts` | `references()`, `semanticTokens()`, trigger characters, legend, per-language `initializationOptions`, 30s timeout |
| `CodeFileEditor.tsx` | reveal-once guard, trigger-char completion, semantic decorations, peek widget, pending toasts |
| `ReferencesPeek.tsx` *(new)* | peek panel presentation |
| `semanticTokens.ts` *(new)* | pure decoder + token-type → class mapping |
| `FileEditor.tsx` | `onRegisterSave` |
| `ExpandedTerminal.tsx` | saver registry, `pendingClose` state, save dialog replacing both `window.confirm` calls |

`CodeFileEditor.tsx` is already 732 lines. The peek panel and the semantic
token decoder go in their own files rather than growing it further.

## Testing

**Step 1 — make the suite runnable.** Install `vitest`, `jsdom` and
`@testing-library/react`, add `"test": "vitest run"`, and get the 12 existing
`.test.ts` files executing. Some may have rotted; failures will be reported as
findings, not quietly patched over.

**New coverage**, favouring pure functions:

- semantic token decoding: relative → absolute positions, multi-line deltas,
  modifier bitmasks, empty data
- reference result mapping: `Location[]`, out-of-worktree URIs, empty results
- trigger-character detection: fires after `.`, not mid-identifier, honours
  `explicit`
- reveal-once guard: same `requestId` applies once across many value changes;
  a new `requestId` re-applies; an empty document defers

**Manual/e2e:** the WebKit + real-endpoint harness already used to diagnose the
compression bug covers the wire behaviour of references, completion and
semantic tokens end to end.

## Out of scope

- Backend LSP changes of any kind.
- Rename, code actions, hover, signature help.
- Semantic tokens delta requests (`semanticTokens/full/delta`) — full requests
  on a debounce are sufficient at these file sizes.
- Changing terminal or SSH WebSocket behaviour.
