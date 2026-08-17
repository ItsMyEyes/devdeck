# Composer — Draft Threads & Prompt Stash

> Spec 1e, subsystem **E**. Follows `2026-08-14-composer-shell-tiptap-editor-design.md`,
> which shipped the shell (G) this one hangs state off.
>
> Everything here is frontend. It touches no Go file, adds no endpoint, and
> changes no wire frame.

## Where this sits

G's decomposition table, updated to what is actually on disk today:

| | Subsystem | Backend needed | State |
|---|---|---|---|
| **G** | Shell + prompt editor + controls | none | **shipped** — `ComposerPromptEditor.tsx`, `composerSerialize.ts`, `composerMention.ts`, `composerNodes.ts` all exist |
| **A** | Pending user-input & approval panels | approval broker, CLI control protocol | contract exists, unimplemented |
| **F** | Banner stack | none | not started |
| **B** | Plan surface | `ExitPlanMode` intercept | not started |
| **C** | Context attachments (images, terminal ctx) | attachment store | not started |
| **D** | Command menu (`/`, `$`) | per-provider catalog | not started |
| **E** | Draft threads & prompt stash | **none** | **this spec** |

**What E depends on.**

- G's value contract. `ComposerPromptEditorProps.value` is a `string`
  (`ComposerPromptEditor.tsx:76-77`) and `ChatComposer` holds it in one
  `useState` (`ChatComposer.tsx:141`). Drafts and stash entries are that same
  string; neither introduces a second representation.
- G's one-way string→doc rule. `parseComposerText` never reconstructs chips
  (`ComposerPromptEditor.tsx:209-218`), so a draft or stash entry restored into
  the editor comes back as literal text — a file chip round-trips as
  `[app.tsx](src/app.tsx)`. That is already true today whenever the parent
  reassigns `value`; E does not change it, and §7 says so out loud.
- The engine's lazy thread creation. A thread row is written by the WebSocket
  hello, not by any create endpoint (`handler/agent_ws.go:129-141`,
  `:239-263`). §4 leans on that: it defers the hello, it does not add an API.
- Nothing else. No `port.Store` method, no domain type, no handler.

**What E is blocked by:** nothing. **What blocks on E:** nothing — C will
extend the stash entry with attachments (§7), and that is the only forward
coupling.

## Problem

Four things, three of them defects with a reproduction.

**1. The composer throws typed text away.** The draft is component state
(`ChatComposer.tsx:141`) and lives nowhere else: `grep -rln localStorage
frontend/src` returns theme, palette frecency, ripgrep prefs, browser
bookmarks, VS Code mode, the confirm dialog, the browser tile, `paneTree.ts`
and the store — nothing for the chat composer. Tab *switching* is safe by
accident (`PaneCanvas.tsx:286-292` renders inactive tabs with `hidden` rather
than unmounting them), which is exactly what makes the loss confusing: the
text survives switching to the terminal and back, then vanishes when the tab
is closed, when the pane is closed, or on reload. Reload is the worst of the
three, because `worktreeLayouts` *is* persisted (`useDevDeckStore.ts:1069-1080`)
— the chat tab comes back, empty.

**2. Connecting remounts the composer.** `showConnecting` is true only while
`status === 'connecting'` with no items, so a brand-new thread renders the
docked branch (`AgentChatPane.tsx:188`, `:220-239`), and the moment the socket
opens `isEmpty` flips and the same `composer` element is re-parented into
`EmptyThread` (`:192`, `:218-219`). Different element type at that position →
React unmounts and remounts `ChatComposer` → `useState('')` is fresh. Type
during the connect window and the text is gone with no user-visible cause.

**3. "New session" writes a permanent row before a character is typed.**
`SessionsPanel.tsx:18-20` states the intent plainly: *"an abandoned new session
costs nothing — no row is written until the socket actually connects."* But the
socket connects unconditionally on pane mount (`useAgentChatSocket.ts:174-283`;
the effect resolves a URL and calls `connect()` at `:259-263`), hello
auto-creates the thread (`handler/agent_ws.go:129-141` → `:245-263`), and the
row is durable and listed from creation — `store/agentevent.go:286-288`:
*"A thread with no events beyond its own creation still appears."* Its title
stays `''` until a first message projects one (`store/agentevent.go:81-93`), so
the sidebar shows "Untitled session" (`SessionsPanel.tsx:107`) forever, and the
only way out is the confirm-and-delete path at `SessionsPanel.tsx:163-169`.
Click "New session" three times while deciding what to ask and you have three
rows to clean up.

**4. There is no way to park a prompt.** A half-written prompt can only be sent
or deleted. It cannot be set aside, and it cannot be moved to another thread —
which is the specific thing a stash is for.

## Non-goals

- **No backend change.** No Go file, no endpoint, no schema, no event type.
- **No image or attachment support.** t3code's stash entry carries
  `attachments`, `droppedImageNames`, `unreadableImageNames` and
  `pendingImageCount` (`promptStashStore.ts:35-56`); DevDeck's carries text and
  nothing else. See §7 for why not even as optional fields.
- **No model / effort / mode capture** in a stash entry, deliberately, for
  t3code's stated reason (`promptStashStore.ts:29-34`): the point of stashing is
  to move a prompt to a different thread or provider, so restoring must never
  drag the old model choice along. DevDeck's model/effort/mode state is
  pane-local (`AgentChatPane.tsx:139-144`) and stays there.
- **No `DraftId` identity and no draft routing context.** t3code's draft session
  carries a mutable `environmentId` / `projectId` / `branch` / `worktreePath` /
  `envMode` / `startFromOrigin` that the user can change before the first send
  (`composerDraftStore.ts:286-299`). A DevDeck chat pane is minted inside one
  worktree (`paneTree.ts:256-260`) and there is no picker for any of those
  fields, so a draft-session record would be five fields nobody can edit. See
  the correction in §4.
- **No sticky cross-thread model selection** (`composerDraftStore.ts:230-238`).
  Its own decision, not this one.
- **No editing, renaming, pinning, tagging or searching stash entries.**
- **No cross-device sync.** Both stores are browser-local, on the same
  reasoning `favouriteModels` already carries (`useDevDeckStore.ts:344-350`):
  the runtime has no per-user store to hang this off.
- **The remount in problem 2 is not fixed, it is made survivable.** Restructuring
  `AgentChatPane`'s hero/docked branches to share a subtree is a layout change
  with its own risks; persisting the draft makes the remount lossless, which is
  the outcome the user cares about.

## Design

### 1. Where the state lives — and the one convergence-file task

Two slices on `useDevDeckStore`, and pure logic in feature modules:

| State | Home | Persisted through |
|---|---|---|
| `composerDrafts: Record<string, ComposerDraft>` | `useDevDeckStore` | the store's own `partialize` |
| `promptStash: PromptStashEntry[]` | `useDevDeckStore` | **its own** localStorage key, not `partialize` |

State in the one store is the repo rule (`.claude/rules/frontend.md`: *"Transient
UI state (dialogs, drafts, sidebar open/close) lives in zustand"*), and the
store already imports its reducers from feature modules rather than inlining
them — `dbTabs.ts`, `tileTree.ts`, `paneTree.ts` (`useDevDeckStore.ts:9-22`).
`composerDrafts.ts` and `promptStash.ts` follow that shape: pure functions plus,
for the stash, a load/save pair. Everything worth testing is testable without a
store.

> **`frontend/src/store/useDevDeckStore.ts` is a convergence file**
> (`CLAUDE.md`; `ORCHESTRATION.md:29-31`: *"Central zustand store — all features
> write to it"*). The implementation plan must put **every** edit to it in
> **exactly one task** — both slices, their actions, and the `partialize` line,
> landed together — and no other task in E, and no parallel agent on any other
> subsystem, may touch that file while E is in flight. This is not a style
> preference: two agents appending actions to the same object literal conflict
> on every hunk. The pre-commit hook typechecks the whole project anyway, so E
> lands as one commit regardless.

### 2. Drafts

```ts
// features/agent-chat/composerDrafts.ts
export interface ComposerDraft { text: string; updatedAt: number }
export const MAX_COMPOSER_DRAFTS = 50
export function setDraft(map, threadKey, text, now): Record<string, ComposerDraft>
export function clearDraft(map, threadKey): Record<string, ComposerDraft>
```

- **Keyed by `threadKey`**, the same key space as `agentThreads`
  (`useDevDeckStore.ts:371`) and the same string the backend calls `ThreadID`
  (`useAgentChatSocket.ts:90`). Two panes on one thread cannot exist — opening a
  thread that is already on screen refocuses it (`ExpandedTerminal.tsx:690-700`)
  — so a key never has two live writers.
- **Empty text deletes the key**, and past `MAX_COMPOSER_DRAFTS` the
  least-recently-updated entry is evicted. Same bounded-map discipline, and the
  same `now`-injected-for-testability shape, as `paletteFrecency.ts:33-43`.
  Unbounded growth matters here: this map shares one persisted blob with every
  worktree layout.
- **`ChatComposer` keeps `useState` as the live value.** The store is a mirror,
  not the source: hydrate once on mount from `composerDrafts[threadKey]`, then
  write back on a **300 ms trailing debounce** (t3code's own
  `COMPOSER_PERSIST_DEBOUNCE_MS`, `composerDraftStore.ts:67`), flushed on
  unmount. `submit()` already clears the text (`ChatComposer.tsx:169-174`); it
  also clears the stored draft, synchronously, so a send is never followed by a
  debounce tick that resurrects it.

  Why not make the store the per-keystroke owner: zustand's persist middleware
  re-serializes the *whole* partialized state on every `setState`
  (`node_modules/zustand/middleware.js:360-371`) — worktree layouts, tile
  layouts, sidebars, git diffs, db tabs. Per-keystroke that is a full blob write
  per character; debounced it is at most three per second. It also keeps the
  editor's controlled-value path byte-identical to what G shipped, so
  `ComposerPromptEditor.tsx` is untouched.

  The cost is honest and bounded: a hard reload within 300 ms of the last
  keystroke loses those characters. t3code buys that back with a `beforeunload`
  flush (`composerDraftStore.ts:74-79`). This spec does not, because DevDeck's
  primary shell is a Tauri window whose close path this spec did not verify, and
  a flush that only works in the browser tab would be a claim the desktop app
  does not honour.
- **`threadKey` becomes an optional prop on `ChatComposer`**, defaulting to
  drafts-disabled. `AgentChatPane` already holds it (`AgentChatPane.tsx:127`)
  and passes it alongside the props it already threads (`:194-206`). Optional,
  not required, for the reason `NO_MACHINE` is already optional
  (`ChatComposer.tsx:70-76`): `ChatComposer.test.tsx` mounts the component
  directly with no thread context, and that file must stay green unmodified.
- **Deleting a thread deletes its draft.** `useDeleteAgentThread`
  (`features/data/queries.ts:1396`) gains a `clearComposerDraft(threadId)` in
  its success path — the backend erases the row, transcript and receipts
  (`store/agentevent.go:267-284`), so a surviving local draft would be the only
  trace left of a conversation the user asked to erase.

### 3. Where the draft is *not* keyed

Not per pane, not per tab, not per worktree. A pane id and a threadKey are the
same string today (`paneTree.ts:256-260`), and keying by worktree would merge
the drafts of `w-abc` and `w-abc::chat-2` into one.

### 4. Draft threads — deferred connect

> **Correction.** The capability survey that opened this work called the
> draft-thread concept "greenfield: DevDeck has no state that exists before the
> thread does", and an earlier draft of this spec proposed porting t3code's
> `DraftId` plus a `draftId → threadId` promotion step. That was wrong, and
> reading two files settled it. DevDeck's `threadKey` **already is** a
> client-minted identity with no backend row behind it —
> `nextFreeThreadKey` computes it locally (`SessionsPanel.tsx:83-90`) and
> `createAgentChatPane` mints the pane from it (`paneTree.ts:256-260`), with no
> create endpoint anywhere. The gap is not identity; it is that the socket opens
> on mount and creates the row anyway. A second id space would have added a
> promotion step, a key migration for the draft map, and a second thing for
> `nextFreeThreadKey` to avoid colliding with — to solve a problem DevDeck
> does not have. The fix is one boolean.

`useAgentChatSocket` gains a `connect` option and a fourth socket status:

```ts
useAgentChatSocket({ machine, threadKey, connect })   // useAgentChatSocket.ts:88-92
export type AgentSocketStatus = 'draft' | 'connecting' | 'open' | 'closed'
```

- `connect === false` → no WebSocket is opened, no hello is sent, no row is
  created. Status is `'draft'`.
- `AgentChatPane` decides: `connect = threadExists || hasSentThisSession`.
  `threadExists` reads `useAgentThreads(machine, worktreeId)` — the *same*
  react-query key `SessionsPanel` already populates
  (`features/data/queries.ts:1379-1387`, `staleTime` 5 s), so in the path that
  matters (the operator just clicked "New session" in a panel rendered from that
  query, `SessionsPanel.tsx:159-161`) the answer is already in cache and costs
  no request.
- **Fail open.** While that query is loading, or if it errored, `connect` is
  true. A stray empty row is a far cheaper failure than a real thread whose
  transcript never loads. Both real paths are still correct: the New-session
  click has the query resolved, and a pane restored from a persisted layout on a
  cold reload connects immediately — which is right, because that thread's row
  already exists.
- **The first send flips the gate.** `sendTurn` sets `hasSentThisSession`, the
  socket connects, hello fires, and the queued command flushes.

**The outbox trap — read this before touching the hook.** Commands issued while
the socket is not open are queued in `outboxRef` and flushed after hello
(`useAgentChatSocket.ts:172`, `:217-218`). But the connect effect *clears* that
queue on entry (`:183`) and on cleanup (`:278`). Adding `connect` to the
effect's dependency list (`:280-283`) therefore wipes the very turn that
enabled the socket: the user's first message would vanish silently. The reset
must move into its own effect keyed on `[machine, threadKey]` only — identity
change means a different thread, where replaying a stale queued command really
would be wrong. The connect effect then keys on `[machine, threadKey, connect]`
and touches the outbox only to flush it. This has a test of its own (§ Testing).

**Consequences to accept, not paper over:**

- A draft thread has no sidebar row until its first message. That is the point
  of the change (problem 3), but it means the pane is the only handle on it.
  Close that tab and the draft text survives under its threadKey while the
  *pane* does not.
- Recovery is partial and worth stating: the primary chat pane of a worktree is
  keyed by the bare worktree id (`paneTree.ts:256-257`), so reopening chat on
  that worktree lands on the same key and the draft returns. An extra
  `::chat-N` pane returns only if `nextFreeThreadKey` hands the same number
  back, which it does — it reuses freed numbers rather than tracking a
  high-water mark (`SessionsPanel.tsx:76-90`).
- `ChatHeader` must handle `'draft'`: `SOCKET_DOT_COLOR` is a
  `Record<AgentSocketStatus, string>` (`ChatHeader.tsx:29-33`), so the typecheck
  will not let this be forgotten. A draft thread's dot uses the idle/dim token,
  not the `connecting` amber — nothing is pending.
- `showConnecting` (`AgentChatPane.tsx:188`) is unchanged and stays correct:
  `'draft'` is not `'connecting'`, so a draft thread goes straight to the hero
  layout instead of showing "Connecting to the agent…" forever.

### 5. Prompt stash

```ts
// features/agent-chat/promptStash.ts
export interface PromptStashEntry { id: string; createdAt: string; text: string }
export const MAX_STASH_ENTRIES = 20              // t3code promptStashStore.ts:17
export const STASH_STORAGE_KEY = 'devdeck.composer.stash.v1'
export function loadStash(): PromptStashEntry[]                 // never throws
export function saveStash(entries): boolean                     // false = not durable
export function stashEntrySnippet(entry): string                // 90 chars, ws-collapsed
```

- **Global, not per thread.** One flat queue across every worktree and machine.
  Moving a prompt to another thread is the feature.
- **Own localStorage key, outside `partialize`.** This is the one place the
  "everything in the one store" rule gives way, and the reason is mechanical.
  The stash's contract is t3code's (`promptStashStore.ts:144-172`, `:228-240`):
  *the composer is cleared only because the write landed*, and a rejected write
  must leave neither a visible entry nor an emptied composer. zustand's persist
  middleware cannot report that — `api.setState` calls `set(...)` first and
  `setItem()` after, with no rollback seam
  (`node_modules/zustand/middleware.js:366-371`), so by the time a quota
  rejection surfaces the in-memory queue has already changed. A boolean-returning
  `saveStash` puts the decision back in the action's hands; the slice commits
  only on `true`. Isolating the key also means a fat stash cannot take the
  layout blob down with it.
- **`loadStash` never throws**, degrading to `[]` on parse failure, blocked
  storage or a sandboxed origin — the same posture `paletteFrecency.ts:57-76`
  takes, and for the same reason: reading storage can itself throw
  (`promptStashStore.ts:121-140`), so the module must not be able to kill app
  boot from an import.
- **Cap 20, evicting the oldest**, prepend-newest. The evicted entry is returned
  to the caller so the toast can say so rather than silently dropping it.
- **Hydrate once at module init**, last-write-wins across tabs, no storage-event
  merging (`promptStashStore.ts:270-283`).

**Store actions** (the single convergence-file task):

```ts
stashPrompt(text: string): { ok: boolean; evicted: PromptStashEntry | null }
takeStashEntry(id: string): PromptStashEntry | null   // restore = remove + return
deleteStashEntry(id: string): void
```

### 6. Stash UI and the chord

**Badge** — `ComposerStashBadge.tsx`, ported from t3code's
(`ComposerStashBadge.tsx:14-56`): a bookmark pill on the composer's top-right
shoulder, hidden at count 0, `onPointerDown` prevented so opening it does not
steal focus from the editor. It needs a positioned ancestor — `SURFACE`
(`ChatComposer.tsx:108-112`) has no `relative` today and gains one.

**Menu** — `ComposerStashMenu.tsx`, ported from `ComposerStashMenu.tsx:32-176`:
newest first, snippet + relative time (`formatDistanceToNow` from `date-fns`,
already used this way at `SessionsPanel.tsx:27`, `:129`), per-row delete,
arrow/Enter/Escape/⌘⌫ handled capture-phase on `window` so the editor's own
keymap does not win while the menu is open (`ComposerStashMenu.tsx:50-90`).

**Popover shell.** `TabStripPopoverMenu` is the right shell — the composer
already uses it (`ChatComposer.tsx:211-221`) and it registers
`useNativeOverlayBlocker` (`components/ui/tab-strip-popover-menu.tsx:29`), which
is not optional here: Tauri Browser tiles are OS-composited above all app DOM,
so an unregistered popup is invisible behind one (`useDevDeckStore.ts:369-381`).
But its `open` state is internal (`:27`, `:32`) and the chord has to open it, so
it gains optional controlled `open`/`onOpenChange` props. Extending the shared
shell beats a second hand-rolled popover that has to re-derive the blocker
wiring.

**⌘S / Ctrl+S.** Non-empty composer → stash and clear. Empty composer → open the
menu. Two findings shape the implementation:

- *The OS does not claim it.* The Tauri menubar holds a DevDeck submenu and an
  Edit submenu of Cut/Copy/Paste only (`src-tauri/src/lib.rs:121-133`) — no
  Save item, so no key equivalent. That file documents exactly how this goes
  wrong when it is claimed (`:104-119`: macOS matches a menu item's key
  equivalent before the webview ever sees a `keydown`), which is why this was
  checked rather than assumed.
- *The app does claim it.* Three editors register **window-level** Cmd/Ctrl+S
  listeners — `FileEditor.tsx:197-207`, `SSHFileEditor.tsx:152-162`,
  `UntitledFileEditor.tsx:62-71` — each gated only on its own tab being active,
  **not** on focus. In a split with a file editor active on the left and the
  chat pane focused on the right, a ⌘S meant for the stash also saves the file.

  So the composer's handler runs **capture-phase on `window`**, gated on the
  composer's editor owning focus, and calls `preventDefault()` **and**
  `stopPropagation()`. Capture reaches window before the bubble-phase listeners
  above ever run. A ProseMirror keymap entry cannot do this job: returning `true`
  from a Tiptap shortcut prevents the default but does not stop propagation, so
  the file editor would still save.

**Restore into a non-empty composer swaps.** The current text is stashed first,
then the restored entry replaces it — ⌘S followed by Enter, atomically. Nothing
is ever destroyed by a restore.

> This rule is ours, not t3code's. The reference gives the store and both
> components but **no call site**: `grep -rn "ComposerStash\|promptStash"` across
> `gg/t3code/apps` and `gg/t3code/packages` returns only
> `promptStashStore.ts`, its test, and the two component files.
> `components/chat/ChatComposer.tsx` — the 3,215-line composer G was ported from
> — never mentions the stash. The trigger, the focus handling and the restore
> semantics are unspecified there and are designed here.

### 7. Dormant on purpose

- **Attachment fields are not ported at all** — not even as optional keys.
  DevDeck has nothing that can produce an image attachment until C lands, and an
  optional field nobody writes is a schema promise with no implementation behind
  it. C adds `attachments` with a `v2` storage key and a one-shot read of `v1`,
  the same shape t3code used when it retired its own v1
  (`promptStashStore.ts:8-15`).
- **Chips do not survive a round-trip.** A stashed or restored prompt is a
  string, and `parseComposerText` never rebuilds chips
  (`ComposerPromptEditor.tsx:209-218`), so `[app.tsx](src/app.tsx)` comes back as
  text. Recorded here so it is not filed later as a stash bug: it is G's
  documented one-way contract, and fixing it means persisting the doc JSON,
  which is C/D's problem, not E's.
- **`'draft'` is a socket status, not a thread status.** `AgentThreadView.status`
  is folded from the server's event log (`useAgentChatSocket.ts:23-27`) and stays
  untouched — a thread that does not exist has no server status to report.

## Data flow

```
keystroke ─▶ TipTap doc ─serialize─▶ string ─▶ ChatComposer useState  (unchanged from G)
                                                   │
                                    300 ms debounce │  flush on unmount
                                                   ▼
                                    store.setComposerDraft(threadKey, text)
                                                   │
                                                   ▼  zustand persist → 'devdeck-ui-v2'
mount ──▶ store.composerDrafts[threadKey] ──▶ useState initial value

send ───▶ onSend(text) ──▶ setText('') + clearComposerDraft(threadKey)

⌘S (text)  ─▶ stashPrompt(text) ─▶ saveStash() ──true──▶ commit + clear composer
                                        └────false─────▶ keep composer, toast
⌘S (empty) ─▶ open menu ─▶ Enter/click ─▶ takeStashEntry(id) ─▶ setText(entry.text)
                                                              (current text stashed first)
```

Thread lifecycle with the gate:

```
pane mount ─▶ threadExists? ──no──▶ connect=false ─▶ status 'draft' ─▶ hero, no row
                   │yes                                    │
                   ▼                                  first send
             connect=true ─▶ ws open ─▶ hello ─▶ replay      │
                                  ▲                          │
                                  └──────────────────────────┘
                                     outbox flushes the queued turn
```

Nothing downstream of `onSend` changes. The command frames, the reducer, the
event log and the backend see exactly what they see today — only *when* the
first frame is sent moves.

## Testing

TDD, and most of this is pure logic with no DOM.

**Unit — `composerDrafts.test.ts`:**
- set / overwrite / clear; empty text deletes the key rather than storing `''`
- eviction at `MAX_COMPOSER_DRAFTS`, dropping the least-recently-updated (`now`
  injected, as `paletteFrecency.test.ts` already does)

**Unit — `promptStash.test.ts`:**
- prepend newest; cap at 20 returning the evicted entry
- `takeStashEntry` removes and returns; unknown id returns null and mutates nothing
- `loadStash` returns `[]` for absent / malformed / throwing storage
- **a failed `saveStash` leaves the queue unchanged** (inject a storage whose
  `setItem` throws) — this is the invariant the whole own-key decision exists for
- `stashEntrySnippet`: whitespace collapsed, truncated at 90 chars with an
  ellipsis, `(empty)` for a blank entry (`ComposerStashMenu.tsx:10`, `:17-24`)

**Component — `ChatComposer` / `AgentChatPane`:**
- text typed then unmounted rehydrates on remount with the same `threadKey`
- a successful send clears the persisted draft (no debounce tick restores it)
- **the hero↔docked remount is lossless**: mount `AgentChatPane` with the mocked
  socket at `status:'connecting'`, type, flip the mock to `'open'` with zero
  items, assert the text is still there. This is problem 2, verbatim.
- ⌘S with text stashes it and empties the composer; ⌘S on an empty composer
  opens the menu; Escape closes it; Enter restores the highlighted entry
- **a window-level Cmd+S listener registered like `FileEditor`'s never fires**
  when the chord is handled by the composer (spy listener on `window`, bubble
  phase, assert zero calls) — the split-pane collision from §6
- restore into a non-empty composer stashes the current text first

**Component — the connect gate (`useAgentChatSocket`):**
- `connect:false` opens no socket (assert the `WebSocket` constructor is never
  called) and reports `'draft'`
- a turn dispatched while disconnected, followed by `connect:true`, is sent
  exactly once after hello — **the outbox trap** (§4). Write this test before
  the change; it fails against the naive dependency-array edit.
- `AgentChatPane` passes `connect:false` for a threadKey absent from
  `useAgentThreads`, and `true` when the query is loading or errored (fail open).
  Its existing test already mocks the hook as `() => mockSocket()`
  (`AgentChatPane.test.tsx:8-10`), so the extra option changes nothing that is
  already green.

**Regression — must stay green, unmodified:** `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `ComposerPromptEditor.test.tsx`,
`composerSerialize.test.ts`, `composerMention.test.ts`, `composerNodes.test.ts`,
`MessagesTimeline.test.tsx`, `eventReducer.test.ts`, `timeline.test.ts`,
`adapter.test.ts`, `SessionsPanel.test.tsx`.

**`vite.config.ts:71-171` `test.include` is an allow-list.** Every new test file
must be added to it by hand or it silently never runs — the most likely way this
work ships with green output and untested code.

`npm test` shows one pre-existing failure in the monaco guard test. It is not a
regression from this work and must not be "fixed" as part of it.

## Risks

**The convergence file.** One task, one commit, no parallel agent on
`useDevDeckStore.ts`. Called out in §1 and repeated here because it is the only
risk in this spec that damages *other people's* work rather than this feature's.

**The outbox trap (§4).** The highest-severity defect this change can introduce:
a silently dropped first message. It is invisible in the UI — the composer
clears, the pane shows an empty thread — so it is covered by a test written
before the change, not after.

**⌘S.** Verified free at the OS level (`src-tauri/src/lib.rs:121-133`), verified
*taken* at the app level by three editors (§6). If the capture-phase gate proves
brittle in the Tauri webview, the fallback is to keep the badge click and move
the chord — **not** to rebind the file editors, whose ⌘S is the older and more
expected binding.

**Storage quota.** Drafts ride the shared `devdeck-ui-v2` blob, and a rejected
write throws out of `api.setState` (`node_modules/zustand/middleware.js:366-371`)
— pre-existing behaviour that already applies to every layout write, not
something E introduces. E bounds its own contribution: 50 drafts max, empty ones
deleted, and the stash on a separate key with a 20-entry cap and a failure path
that does not clear the composer.

**Deferred connect changes when a session appears in the sidebar.** Intended
(problem 3), but it is a visible behaviour change: a new session is no longer
listed until its first message. §4 states the recovery path and its limit
honestly rather than claiming there is none.

**Debounce loss window.** Up to 300 ms of typing is lost to a hard reload. Stated
in §2, deliberately not patched with a `beforeunload` handler this spec cannot
verify in the desktop shell.

## Files

**New** (all under `frontend/src/features/agent-chat/`):
`composerDrafts.ts` + `composerDrafts.test.ts`, `promptStash.ts` +
`promptStash.test.ts`, `ComposerStashBadge.tsx`, `ComposerStashMenu.tsx` +
`ComposerStashMenu.test.tsx`.

**Modified:**
- `store/useDevDeckStore.ts` — **one task only**: both slices, their actions,
  `composerDrafts` added to `partialize` (`:1069-1080`). No version bump: adding
  a key to the persisted shape needs no `migrate` (`:1087-1100`).
- `features/agent-chat/ChatComposer.tsx` — optional `threadKey` prop, draft
  hydrate/mirror, `relative` on `SURFACE` (`:108-112`), badge + menu, the ⌘S
  capture handler.
- `features/agent-chat/AgentChatPane.tsx` — passes `threadKey` to the composer,
  owns the `connect` gate.
- `features/agent-chat/useAgentChatSocket.ts` — `connect` option, `'draft'`
  status, outbox reset split out of the connect effect.
- `features/agent-chat/ChatHeader.tsx` — `SOCKET_DOT_COLOR` gains `'draft'`
  (`:29-33`); the typecheck forces it.
- `components/ui/tab-strip-popover-menu.tsx` — optional controlled `open` /
  `onOpenChange`.
- `features/data/queries.ts` — `useDeleteAgentThread` clears the thread's draft.
- `vite.config.ts` — the four new test files added to `test.include`.

**Untouched:** every Go file; `ComposerPromptEditor.tsx`, `composerSerialize.ts`,
`composerMention.ts`, `composerNodes.ts`, `ComposerChip.tsx` (the whole G editor
stack); `ComposerControls.tsx`; `MessagesTimeline.tsx`; `eventReducer.ts`;
`adapter.ts`; `SessionsPanel.tsx`; `paneTree.ts`; the vendored
`components/ai-elements/*`.
