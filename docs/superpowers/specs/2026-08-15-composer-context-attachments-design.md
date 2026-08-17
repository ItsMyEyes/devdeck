# Composer — Context Attachments (images, terminal context, element context)

> Subsystem **C** of `2026-08-14-composer-shell-tiptap-editor-design.md`.
>
> C is the largest remaining subsystem and the only one that spans backend
> storage, the provider turn payload, and three separate capture surfaces.
> This document is **one design across five independently shippable pieces**,
> not one landing. See "Where this sits" for the order and the reason for it.

## Where this sits

G (shell + TipTap prompt editor) has landed in the working tree — the editor,
the three chip node types, and the pure serialization all exist
(`ComposerPromptEditor.tsx`, `composerNodes.ts:148-158`,
`composerSerialize.ts`). C is what fills the holes G deliberately left.

The survey below found DevDeck has **none** of C's storage and **neither** of
its two capture surfaces. So C decomposes:

| | Piece | Depends on | Backend | Ships |
|---|---|---|---|---|
| **C0** | Terminal-chip delimiter fix | nothing | none | alone, first |
| **C1** | Attachment store + upload route + adapters consume | nothing | all of it | alone (no UI) |
| **C2** | Images in the composer | C1 | none | after C1 |
| **C3** | Terminal-context capture | C0 | none | after C0 |
| **C4** | Element-context capture | C3's chip plumbing | none | **not scheduled** — see §6 |

Order: **C0 → C1 → C2 → C3**, with C4 specified and deferred. C0 and C1 are
independent of each other and could be worked in parallel, but the pre-commit
hook typechecks the whole project, so they land as separate sequential commits
regardless (same constraint the G spec records under "Commit granularity").

C0 is first and is tiny, because **nothing may insert a terminal-context chip
until its serialized form is self-delimiting**, and C3 is the thing that
inserts one. C1 is before C2 because C2 is a client for an endpoint that does
not exist yet.

Agent chat is still behind the build-time gate (`enabled.ts:18-23`: hidden in
`vite build` output unless `VITE_AGENT_CHAT=1`). None of C changes that.

## Problem

### 1. The attachment pipe is a scaffold that terminates nowhere

Every layer between the WebSocket and the CLI already names attachments, and
not one of them does anything with them:

- `provider.SendTurnInput.Attachments []Attachment` (`provider.go:175`) and
  `provider.Attachment` itself (`provider.go:181-187`).
- `orchestration.TurnStartPayload.Attachments` (`command.go:81`), decoded
  straight off the socket.
- `workers.go:473` forwards `p.Attachments` into `SendTurn`.
- `claude/adapter.go:393` builds `content` from `in.Text` alone;
  `in.Attachments` appears nowhere in the file. `pi/adapter.go:336` is
  `map[string]any{"type": "prompt", "message": in.Text}` — same.
- The client never populates it. `useAgentChatSocket.ts:111`'s own doc comment
  says so: *"Attachments are still to come."* `sendTurn` dispatches
  `{ text, model }` and nothing else (`useAgentChatSocket.ts:316`).

A half-plumbed field is worse than an absent one, because it reads as support.
It has a second, quieter defect: `provider.Attachment` carries **no JSON
tags** (`provider.go:181-187`), so it decodes off the wire under Go field
names — `{"Kind":…,"MIME":…,"Data":…}`. This is the exact bug
`provider.ModelSelection` was fixed for, and the fix's own comment
(`provider.go:150-154`) says why it was invisible: *"the frontend never sent
this field at all."* Same here.

### 2. Bytes cannot ride the turn command, and the scaffold assumes they can

`Attachment.Data []byte` (`provider.go:185`) on a JSON-decoded payload means
base64 bytes inside the `thread.turn.start` command. Three independent
reasons that cannot ship on DevDeck:

- **The socket refuses it.** `agent_ws.go:77` — `conn.SetReadLimit(1 << 20)`.
  One megabyte per frame, for the whole command. A 700KB screenshot is
  ~933KB of base64 before the rest of the payload.
- **It would be persisted, twice, forever.** `engine.go:127-130` emits the
  decoded `TurnStartPayload` verbatim as *both* `EvtThreadMessageSent` and
  `EvtThreadTurnStartRequested`, and `CommitAgentEvents` writes each event's
  payload into `agent_event` (`store/agentevent.go:37-42`).
- **It would be replayed into RAM on every boot.** `main.go:422` calls
  `st.AllAgentEvents()` — the *entire* log, every thread, into the engine's
  in-memory state. And `AgentEventsSince` re-sends a thread's payloads to
  every reconnecting client.

> **Correction.** The obvious port of t3code puts the bytes in the command:
> `ClientThreadTurnStartCommand.message.attachments` is an array of
> `UploadChatImageAttachment`, each with a `dataUrl` capped at 14,000,000
> characters (`t3code/packages/contracts/src/orchestration.ts:167-176`,
> `:794-801`), which the server persists and rewrites into an id-only
> `ChatImageAttachment` in the durable event. DevDeck's existing
> `Attachment.Data []byte` is shaped for exactly that. This spec does **not**
> do it. t3code's server is a per-user Node process with a filesystem and no
> comparable frame limit; DevDeck's is a shared Go runtime whose agent socket
> caps frames at 1MB and whose event log is fully replayed at boot. The
> corrected design is id-only in the command, bytes out of band over HTTP.
> `Data` becomes a server-side-only field (`json:"-"`), populated from the
> store inside the adapter.

### 3. There is no chat attachment store

`handler/attachment.go` and `port.Store`'s `CreateAttachment` /
`ListAttachments` / `AttachmentData` / `DeleteAttachment`
(`port/store.go:60-64`) exist, but they are the **issue description editor's**
uploads: keyed by `issueID`, routed under `/api/issues/{issueId}/attachments`
(`main.go:628-631`). Nothing about them is thread-scoped, and
`AttachmentHandler` holds a concrete `*store.Store` (`attachment.go:18`)
rather than `port.Store`, which the newer agent handlers do
(`agent_thread.go:13-23`). They are a precedent for the storage *shape*, not
a thing to extend.

### 4. `@label` has no terminator — and no referent

`composerSerialize.ts:54-57` serializes a terminal-context chip as
`` `${CHIP_PREFIX[node.kind]}${node.value}` `` → `@terminal-1:12-13`, locked in
by `composerSerialize.test.ts:84-86`. Its own comment already flags the
problem and hands it to this spec: *"neither has one here, so neither may be
inserted next to arbitrary text until then."*

The G spec's correction for the file chip applies unchanged: a bare prefix has
no terminator, so `@terminal-1:12-13please` and `@a:1-2@b:3-4` are both
reachable outputs, and no separator rule repairs it in general.

There is a second defect specific to this chip, which the file chip does not
have. `[app.tsx](src/app.tsx)` is a *complete* reference — the agent can open
that path. `@terminal-1:12-13` is a **dangling pointer**: the lines it names
exist only in a browser-side xterm buffer the agent cannot reach. t3code
solves this by appending the captured text as a trailing
`<terminal_context>` block (`t3code/apps/web/src/lib/terminalContext.ts:159-182`,
`:211-221`), so the inline label is a pointer *into the same message*. DevDeck
has no such block. Fixing the terminator without shipping the referent would
produce a well-formed reference to nothing.

### 5. Neither capture surface exists

- **Terminal.** `TerminalHandle` exposes `sendInput`, `focus`, `copyBuffer`
  and nothing else (`Terminal.tsx:26-32`, `:169-177`); `copyBuffer` serializes
  the *whole* scrollback to the OS clipboard. There is no selection hook, no
  bridge to a composer, no consumer of `xterm`'s `getSelection()` /
  `getSelectionPosition()` — both verified present in the *installed*
  package's typings, `node_modules/@xterm/xterm/typings/xterm.d.ts:1168,1173`
  (`@xterm/xterm@^6`, `package.json:58`), read rather than assumed from docs.
  The dormant `composerTerminalContextChip` node (`composerNodes.ts:153-155`)
  has no producer.
- **Element.** Nothing. No picker, no `elementContext` chip kind
  (`composerNodes.ts:33-53` registers exactly three), and the browser is
  native Tauri webviews (`browserTilesBridge.ts:1-6`,
  `invoke('browser_tile_open')`), i.e. **desktop-only and outside the DOM**.

## Non-goals

- **No approval, plan, banner, command-menu or draft work.** Subsystems A, B,
  D, E and F are untouched. In particular `$` stays dormant: C0 fixes the
  `terminalContext` prefix and deliberately leaves `skill: '$'` in
  `CHIP_PREFIX` for D to own. Fixing a trigger nobody has turned on yet, in a
  spec that does not turn it on, hides the decision from the spec that should
  be making it.
- **No image *editing*** — no cropping, annotation, or markup.
- **No lightbox.** t3code's `ExpandedImagePreview.tsx` is a 32-line pure
  selector (`buildExpandedImagePreview`) feeding a full-screen viewer. C2
  ships thumbnails that open the raw bytes in a new tab. The viewer is a
  follow-up, and the selector is trivially portable when it happens.
- **No non-image attachments.** `Attachment.Kind` keeps room for `"file"`, but
  C1 accepts `image/*` only, matching t3code, whose `ChatAttachment` union has
  exactly one member (`orchestration.ts:179`).
- **No draft persistence.** Pending images and terminal contexts live in
  component state and die with the pane. Persisting them is subsystem E's
  problem, and E must decide it explicitly — see §5's note on expiry.
- **No pi image support in C1.** See §2's named gap.
- **No element picking.** C4 is specified, not scheduled (§6).

## Design

### C0 — a self-delimiting terminal-context reference

The chip's serialized form becomes a markdown link, reusing the file chip's
already-ported and already-tested escaping (`composerSerialize.ts:37-48`):

```
label  → Terminal 1 lines 12-40        (escapeMarkdownLinkLabel)
dest   → terminal:<sessionKey>/L12-L40 (encodeMarkdownLinkDestination)
result → [Terminal 1 lines 12-40](terminal:sess-7f2a/L12-L40)
```

Brackets terminate the label and parentheses terminate the destination, so
adjacency stops mattering — the same argument the G spec's correction makes.
`terminalContext` leaves `CHIP_PREFIX`, which keeps only `skill`.

Two properties are load-bearing:

- The destination contains **no `#` and no `?`**, because
  `encodeMarkdownLinkDestination` percent-encodes both
  (`composerSerialize.ts:41-48`, lines 45-46).
  `L12-L40` as a path segment survives `encodeURI`; `#L12-L40` would become
  `%23L12-L40` and stop reading as a line range.
- The destination is the **join key** to the `<terminal_context>` block C3
  appends. A block entry whose header does not match a link destination in the
  same message is a bug, and §7 tests exactly that.

Considered and rejected: `@[Terminal 1 lines 12-40]`, which keeps the `@`
sigil and terminates it. It needs a new escaping function and new tests for
`]` inside a label, to produce a token no more parseable than a markdown link
that already has both.

**C0 ships alone, changes one function and two tests, and inserts nothing.**

### C1 — the attachment store, the upload route, and adapters that read it

**Storage: a SQLite blob, not a directory.** New table `agent_attachment`
(`id`, `thread_id`, `name`, `mime_type`, `size_bytes`, `created_at`, `data`),
mirroring the issue-attachment shape that already works
(`store/attachment.go`). t3code uses a filesystem `attachmentsDir` and pays
~110 lines for it: an id grammar (`attachmentStore.ts:14-20`), a normalize +
resolve pair guarding traversal (`:69-97`), and an extension-probing path
lookup (`:79-97`). A blob column needs none of that, and it makes deletion
atomic with the thread it belongs to — `DeleteAgentThread` already deletes
three tables in one transaction (`store/agentevent.go:267-284`) and gains a
fourth statement rather than a filesystem call that cannot join the
transaction.

New `port.Store` methods, named to the existing convention
(`CONTRACTS.md` "Store interface contract"):

```go
CreateAgentAttachment(threadID, name, mimeType string, data []byte, createdAt string) (domain.AgentAttachment, error)
AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error)
DeleteOrphanAgentAttachments() (int, error)   // startup sweep, see Risks
```

`domain.AgentAttachment` is mirrored into `frontend/src/store/types.ts` in the
same change (`CONTRACTS.md` "Domain type mirroring"). `data` is never on the
JSON shape.

**Routes**, next to the existing agent-thread routes (`main.go:855-857`), so
they exist on every role — chat runs on runtimes:

```
POST /api/agent/threads/{threadId}/attachments   multipart, field "file"
GET  /api/agent/attachments/{id}                 raw bytes
```

`POST` mirrors `AttachmentHandler.PostAttachment` (`attachment.go:26-56`):
`http.MaxBytesReader`, `ParseMultipartForm`, 400 on missing/oversize. It adds
an `image/*` check on the sniffed content type (400 otherwise) and a 10MB cap.
`GET` mirrors `GetAttachment` (`attachment.go:69-80`) including
`Cache-Control: private, max-age=31536000, immutable`, which is honest here:
an attachment id is immutable. The handler takes `port.Store`, following
`AgentThreadHandler` (`agent_thread.go:13-23`), not the older
`AttachmentHandler`. Store errors go through `handleStoreErr`.

**Wire shape.** `provider.Attachment` gains JSON tags and loses `Data` from
the wire:

```go
type Attachment struct {
    ID   string `json:"id"`
    Kind string `json:"kind"`           // "image" | "file"
    MIME string `json:"mime"`
    Name string `json:"name"`
    Data []byte `json:"-"`              // filled server-side from the store
    Path string `json:"-"`              // unused today; kept, not serialized
}
```

Adding the tags is not cosmetic and not deferrable: the frontend starts
sending this field in C2, and an untagged struct would have it silently
ignored (`provider.go:150-154` documents that exact failure for
`ModelSelection`).

**Where the bytes get loaded.** `workers.go:473` already forwards
`p.Attachments`. It gains one step before `SendTurn`: for each attachment,
`AgentAttachmentData(a.ID)` → `a.Data`. This is the reactor, which already
holds the store. Doing it here rather than per-adapter means one load path and
one error path, and it keeps the event log free of bytes: the persisted
payload holds ids, and the ids are resolved at dispatch time.

**Claude.** `adapter.go:393-399` builds
`content: []map[string]any{{"type":"text","text":in.Text}}`. It appends one
block per image, in the shape t3code sends
(`t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:1210-1218,1236-1279`):

```go
{"type":"image","source":{"type":"base64","media_type":a.MIME,"data":<base64>}}
```

MIME is checked against the same allow-list t3code enforces
(`ClaudeAdapter.ts:1165-1170`): `image/gif`, `image/jpeg`, `image/png`,
`image/webp`. An unsupported type fails the turn with a clear error rather
than being dropped silently.

**Pi — a named gap, not a silent one.** `pi/adapter.go:336` sends
`{"type":"prompt","message":<string>}`. Whether pi's stdio protocol accepts
image content at all is **unverified**; this repo has learned not to trust
pi's docs (the `switchModelIfNeeded` comment at `pi/adapter.go:342-350`
records the same class of problem for `set_model`). C1 therefore leaves pi's
`SendTurn` sending text only and **returns an error when `in.Attachments` is
non-empty**, so a user on pi is told the turn cannot carry the image instead
of silently sending a prompt about an image the agent never received. Turning
that error into support requires a live capture of the pi binary first.

**C1 ships with no UI.** It is verified entirely by Go tests.

### C2 — images in the composer

**Capture.** Three entry points on the composer surface: paste (
`ClipboardEvent.clipboardData.files`), drop on the surface, and a paperclip
button in the footer next to the controls. All three converge on one
`addFiles(FileList)`.

**Downscale before upload.** Port t3code's ladder
(`t3code/apps/web/src/lib/imageCompression.ts`): longest edge 2048px, quality
steps `[0.92, 0.85, 0.78, 0.68]`, then two fallback scale steps, refusing only
above a 50MB *source* because decoding hundreds of megapixels can OOM the tab.
The point is not bandwidth — it is that a retina screenshot pasted at full
size is routinely over the cap, and rejecting the paste is a worse answer than
re-encoding it.

**Upload immediately, on add, not on send.** `uploadAgentAttachment(machine,
threadId, file)` via `machineXhr` with `FormData`, mirroring
`uploadWorktreeFileWithProgress` (`machineApi.ts:121-137`) — which is also the
reason to use `machineXhr` rather than `fetch`: it routes direct-first with
hub-proxy fallback, so the upload lands on the runtime that will run the turn.
Uploading on add (not on submit) means the send path stays synchronous and the
progress indicator has somewhere to live.

**Where they render.** The shell reserves `data-slot="composer-panels"` for
subsystem A (`ChatComposer.tsx:189-191`). C2 adds a **sibling** slot,
`data-slot="composer-attachments"`, between that div and the editor — a
wrapping row of thumbnails, each with a remove control and, while uploading, a
progress ring. A's slot is not shared.

**The send contract widens by one argument.** `ChatComposer`'s
`onSend: (text: string) => void` (`ChatComposer.tsx:80`) becomes
`(text: string, attachments: AgentAttachmentRef[]) => void`;
`useAgentChatSocket.sendTurn(text, model)` becomes
`sendTurn(text, model, attachments)` and puts them in the payload
(`useAgentChatSocket.ts:316`). The prompt editor's own value contract — a
plain `string` — is **unchanged**. Images are not chips and never enter the
TipTap document.

**Echo in the transcript.** `eventReducer.ts:285` builds the user `ChatItem`
from `event.payload.text` only, so without this the user sends an image and
sees nothing. `ChatItem` gains
`attachments?: { id, name, mimeType }[]` (`types.ts:15-49`), read from the
same payload, and `MessagesTimeline`'s user bubble (`MessagesTimeline.tsx:86-104`)
renders them as thumbnails sourced from `GET /api/agent/attachments/{id}`.
This is why C1 ships the GET route: after a reload the local `File` is gone
and the blob is the only copy.

### C3 — terminal context

**Selection → capture.** `TerminalHandle` (`Terminal.tsx:26-32`) gains
`captureSelection(): TerminalContextSelection | null`, built from xterm's
`getSelection()` (text) and `getSelectionPosition()` (an `IBufferRange`, so
real line numbers). It returns `null` for an empty selection. `Terminal.tsx`
also shows a small "Send to chat" affordance while a selection exists,
driven by `onSelectionChange` (`xterm.d.ts:996`).

**The bridge.** `ExpandedTerminal.tsx` already owns both sides: it holds
`termHandles` keyed by session (`:271`, `:1056-1063`) and renders every
`AgentChatPane` (`:1130-1142`). It gains a `pendingTerminalContext` state keyed
by thread, passed down to `AgentChatPane` → `ChatComposer`.

**Which thread receives it** is a real decision, not a detail.
`activeThreadKey` (`ExpandedTerminal.tsx:715-722`) is the *focused* pane's
thread — and while you are selecting terminal text the focused pane is the
terminal, so it is always `undefined` at exactly the moment we need it. The
rule instead: **the most recently focused agent-chat tab in this worktree's
layout**; if there is none, capture opens one (`openAgentChatThread`,
`:695-714`, already handles "open or refocus"). Tracking last-focused chat is
one extra field on the layout state, updated where `focusedPaneId` already is.

**Insertion needs an imperative handle.** `ComposerPromptEditor` is fully
controlled by `value: string`, and a chip **cannot** be injected through it:
`parseComposerText` never reconstructs chips from a string, by design
(`composerSerialize.ts:127-130`). So the editor gains a
`ref.insertChip(kind, value, label)`. The existing external-value effect
(`ComposerPromptEditor.tsx:213-218`) survives untouched: the insert fires
`onUpdate`, which sets `lastValue` and calls `onChange`, so parent state and
`lastValue` agree and the effect's `lastValue.current === value` guard short-
circuits. That guard is the thing most likely to break here, and §7 tests it.

**The block, at send time.** On submit, read the chips out of the live
document (`editor.getJSON()`), keep the `terminalContext` ones in document
order, look each `value` up in the composer's capture map, and append a
`<terminal_context>` block — port of `buildTerminalContextBlock`
(`t3code/apps/web/src/lib/terminalContext.ts:159-182`) and
`appendTerminalContextsToPrompt` (`:211-221`).

Reading the chips from the document is a **deliberate simplification of
t3code**, which stores the draft as a plain string with `U+FFFC` placeholders
and then has to count, insert, remove and re-materialize them
(`terminalContext.ts:45`, `:184-209`, `:305-372` — five functions of
placeholder bookkeeping). DevDeck's document holds typed atoms, so the chip
*is* the reference: delete the chip and its block is gone, with no bookkeeping
at all. Roughly 190 lines of t3code do not get ported.

**Display must strip it.** The user bubble renders raw text
(`MessagesTimeline.tsx:86-104`), so an un-stripped block dumps 40 lines of
terminal output into the transcript. Port `extractTrailingTerminalContexts`
(`terminalContext.ts:223-246`) as a pure function, strip in the timeline, and
render the count as a collapsible affordance. Copy still yields the full text,
matching t3code's `copyText`/`visibleText` split (`terminalContext.ts:26-38`).

**Expiry is deliberately not ported.** t3code marks a context expired when its
text is empty (`terminalContext.ts:54-60`) because its drafts survive reloads
through `localStorage`, where the referenced buffer may be long gone. C3's
capture map is in-memory and dies with the pane, so a context that exists
always has its text. **When subsystem E adds draft persistence it must either
persist the captured text or drop the contexts** — reviving a draft with a
chip whose text is gone reintroduces exactly the state t3code's expiry flag
exists for. Flagged here because E's spec will not otherwise know.

### C4 — element context (specified, not scheduled)

Not deferred for effort. Deferred because two prerequisites are missing and
one of them is not ours to add.

- **It can only exist on desktop.** Browser tiles are native Tauri webviews
  composited above the DOM (`browserTilesBridge.ts:1-6`; `BrowserTile.tsx`'s
  comments at `:54-56`, `:314-316`). There is no iframe to attach a listener
  to, and no element-picking story for the web deployment at all.
- **The injection channel does exist**, which is the good news:
  `browser_tiles.rs:328-365` already evals a script into a tile and gets a
  value back through `eval_with_callback` (find-in-page), and `:89-91` shows
  the per-webview page-load hook. A picker would be the same mechanism with a
  bigger payload.
- **The payload's signal is missing.** t3code's `PickedElementPayload` carries
  `componentName` and a source frame — file and line
  (`t3code/apps/web/src/lib/elementContext.ts:17-34`) — supplied by react-grab
  in the *inspected app*. That is most of the value: `formatElementContextLabel`
  prefers `<Button>` over `<button>` (`:116-119`), and the chip's subtitle is
  `file:line` (`:126-132`). DevDeck has no such dependency and no
  source-mapping story, so every pick would yield `componentName: null` and
  `source: null`, i.e. a tag name and an outerHTML blob.
- No `elementContext` chip kind exists (`composerNodes.ts:33-53` has three).
  Adding it is trivial *after* C3, which establishes the pattern for a
  capture-surface-driven chip with an out-of-band body.

Revisit when there is either a source-mapping story or a non-Tauri browser
surface. Until then the honest answer is that the port would ship the chrome
of the feature without the part that makes it useful.

## Data flow

```
C1/C2 — images
  paste/drop/pick ─▶ downscale ─▶ POST /api/agent/threads/{id}/attachments
                                          │ (machineXhr, direct-first)
                                          ▼
                                   agent_attachment row ── id
                                          │
  thread.turn.start { text, attachments:[{id,kind,mime,name}], model }
                                          │  (≤1KB — no bytes on the socket)
                                          ▼
                     engine.Decide ─▶ events (ids only, persisted)
                                          ▼
              workers.go: AgentAttachmentData(id) ─▶ a.Data
                                          ▼
        claude: content += {"type":"image","source":{base64}}
        pi:     error("this provider cannot carry attachments")

C0/C3 — terminal context
  xterm selection ─▶ captureSelection() ─▶ ExpandedTerminal bridge
                                          ▼
                     editor.insertChip('terminalContext', 'sess-7f2a/L12-L40')
                                          ▼
   submit ─▶ serializeComposerDoc  → "…[Terminal 1 lines 12-40](terminal:…)…"
          ─▶ appendTerminalContextsToPrompt → + "\n\n<terminal_context>…"
                                          ▼
                             onSend(text)  ── unchanged signature
                                          ▼
                     transcript strips the block for display
```

The two halves share nothing but the composer surface. That is the reason they
are separately shippable.

## Testing

TDD, and most of the risk is in pure functions.

**C0 — unit, no DOM.** Terminal chip → markdown link; a chip immediately
followed by text (`…)please`, the case the old form got wrong); two adjacent
chips; a label containing `[`/`]`; a session key containing a character
`encodeURI` touches. `composerSerialize.test.ts:84-86` is **updated by this
spec** — it currently asserts the broken form.

**C1 — Go.** Store round-trip (create → read → thread delete cascades);
handler rejects a non-image, an oversize body, and a missing `file` field with
400 and the `{"error":…}` envelope; `AgentAttachmentData` on an unknown id →
`store.ErrNotFound` → 404 through `handleStoreErr`. Adapter-level: a
`SendTurnInput` with one image produces a `content` array of exactly
`[text, image]` with a correct base64 body; an unsupported MIME fails the
turn; pi with a non-empty `Attachments` errors. `provider.Attachment` round-
trips through `json.Marshal`/`Unmarshal` under the **camelCase** keys — the
regression test for the untagged-struct defect.

**C2 — component.** Paste inserts a thumbnail and fires one upload; remove
before send drops it from the payload; send clears both text and thumbnails;
an upload failure surfaces a toast and leaves the draft intact (`frontend.md`:
every data surface renders explicit loading/error/empty states).

**C3 — unit.** `buildTerminalContextBlock` output; `extract…` round-trips it
back; **every link destination in the serialized text has a matching block
entry, and vice versa** — the join-key property C0 §"load-bearing" sets up.
Component: insert-chip through the ref does not trip
`ComposerPromptEditor`'s external-value effect into clobbering the document
(the trap named in C3); removing the chip removes the block from the sent
string.

**Regression — must stay green, unmodified:** `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `ComposerPromptEditor.test.tsx`,
`composerMention.test.ts`, `composerNodes.test.ts`, `ComposerChip.test.tsx`,
`AgentChatPane.test.tsx`, `MessagesTimeline.test.tsx`, `eventReducer.test.ts`,
`timeline.test.ts`, `adapter.test.ts`; on the Go side `agent_ws_test.go`,
`agent_smoke_test.go`, `claude/driver_test.go`, `workers_test.go`,
`workers_reactor_test.go`.

`npm test` shows one pre-existing failure in the monaco guard test. It is not
a regression from this work and must not be "fixed" as part of it.

## Risks

**Orphaned attachments — the weakest part of this design.** An upload
succeeds, the user deletes the thumbnail or closes the pane, and the row is
never referenced by any event. Thread deletion cascades
(`store/agentevent.go:267-284` gains a fourth statement), and
`DeleteOrphanAgentAttachments` sweeps rows whose `thread_id` has no
`agent_thread` row at startup. Neither catches an orphan inside a live thread.
That leak is bounded (10MB × human upload rate) and **accepted for C1**, with
the follow-up named: a `pending`/`sent` column flipped when a turn referencing
the id is accepted, and a TTL sweep of stale `pending` rows.

**The 1MB frame limit is a cliff, not a slope.** Ids keep the command far
under it, but there is no test today that would notice a regression that put
bytes back in the payload. C1 adds one: a turn command carrying eight
attachments must serialize under 4KB.

**Blob size in SQLite.** 10MB per image, 8 per turn (t3code's numbers —
`orchestration.ts:145-146`), enforced server-side, with client-side downscale
so the cap is rarely reached. Reads are one row at dispatch time, not on the
hot path.

**Pi divergence.** C1 makes pi *fail* on attachments rather than silently drop
them. That is deliberate and it is also a visible regression in capability
parity between providers — the composer should disable the paperclip when the
bound instance is pi rather than let the user discover it at send time. C2
owns that gating.

**The chip-insert ref vs. the controlled value.** Named in C3 and tested
directly. This is the one place where G's "value is a string" contract and C3's
"a chip is a node" requirement genuinely rub against each other.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
none of these pieces can be committed file-by-file. Each of C0/C1/C2/C3 lands
as one commit.

## Files

**C0** — `composerSerialize.ts` (serialization + `CHIP_PREFIX`),
`composerSerialize.test.ts`.

**C1, new** — `backend/internal/store/agentattachment.go`,
`backend/internal/handler/agent_attachment.go` (+ tests).
**C1, changed** — `backend/internal/port/store.go` (**convergence file —
serialize this edit**), `backend/internal/domain/models.go` (**convergence
file**), `frontend/src/store/types.ts` (**convergence file**; domain mirror),
`backend/cmd/server/main.go` (**convergence file**; two routes),
`provider/provider.go` (JSON tags on `Attachment`),
`orchestration/workers.go` (load bytes before `SendTurn`),
`provider/claude/adapter.go` (image content blocks),
`provider/pi/adapter.go` (explicit error), `store/db.go` (migration).

**C2, new** — `ComposerAttachments.tsx`, `imageCompression.ts` (+ tests).
**C2, changed** — `ChatComposer.tsx` (attachment slot, `onSend` arity),
`AgentChatPane.tsx`, `useAgentChatSocket.ts` (payload), `eventReducer.ts` +
`types.ts` (`ChatItem.attachments`), `MessagesTimeline.tsx` (thumbnails),
`lib/machineApi.ts` (upload helper).

**C3, new** — `terminalContext.ts` (+ tests), `TerminalContextChip` wiring.
**C3, changed** — `Terminal.tsx` (`captureSelection`, selection affordance),
`ExpandedTerminal.tsx` (bridge + last-focused-chat tracking),
`ComposerPromptEditor.tsx` (imperative `insertChip`), `ChatComposer.tsx`
(capture map, block on submit), `MessagesTimeline.tsx` (strip for display).

**Untouched by all of C** — `frontend/src/routeTree.gen.ts`,
`frontend/src/store/useDevDeckStore.ts`, `composerMention.ts`,
`composerNodes.ts` (until C4 adds a fourth kind), `ComposerControls.tsx`,
`backend/internal/handler/attachment.go` and the issue-attachment store,
the vendored `components/ai-elements/*`.
