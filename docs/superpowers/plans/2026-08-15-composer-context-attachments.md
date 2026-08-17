# Plan — Composer Context Attachments (Subsystem C)

Spec: `docs/superpowers/specs/2026-08-15-composer-context-attachments-design.md`

Format model: `docs/superpowers/plans/2026-08-14-composer-shell-tiptap-editor.md` —
same TDD-first, chain-with-independent-heads structure, same file-ownership
discipline.

Execution: TDD throughout. Every task's tests are written first, against the
behavior described, and the task is not done until its own tests are green.

Scope: **C0, C1, C2, C3** (15 tasks). **C4 is specified in the spec but not
scheduled** — see the closing section for why, unchanged from the spec's own
reasoning. Nothing in this plan turns on `$` (skill triggers, subsystem D) or
touches drafts/stash (subsystem E).

## Known-good baseline

- **Frontend:** `npm test` (from `frontend/`) has **one pre-existing failure**
  in the monaco guard test. Not caused by this work, not to be "fixed" here.
  Any *second* failure after a task lands is a real regression.
- **Backend:** verified clean on the current working tree before writing this
  plan (2026-08-15) — `go build ./...`, `go vet ./...`, and
  `go test ./internal/agentcore/... ./internal/store/... ./internal/handler/...`
  all pass with no failures. The backend baseline for this plan is **zero
  pre-existing failures**; any failure introduced by a C1 task is real.
- The working tree is **not** a clean checkout of `main` — `git status` at
  the start of this session shows dozens of already-modified files (G's
  composer-shell plan and other in-flight work). Verify against the working
  tree, never a fresh clone or `git stash`.

## Corrections found while grounding this plan

Three things the spec asserts that do not match the code as read for this
plan. Each is folded into the relevant task below, not treated as a footnote:

1. **The spec's C1 Files list omits `backend/internal/store/agentevent.go`**,
   even though its own Design section requires it: `DeleteAgentThread`
   (confirmed at `store/agentevent.go:267-284`) deletes three tables in one
   transaction and must gain a fourth `DELETE FROM agent_attachment` statement
   for the cascade the spec describes. **T2** owns this file.
2. **`orchestration.Reactor` does not currently hold a store field of any
   kind** (confirmed: `workers.go:322-343` — `Engine`, `Provider`, `Broker`,
   `InstanceFor`, `OnInstanceStarted`, nothing else). The spec's claim ("this
   is the reactor, which already holds the store") is false as written. **T7**
   adds a new narrow `AttachmentReader` interface + field to `Reactor` —
   mirroring the existing `EventStore` pattern in `orchestration/portstore.go`
   ("declared HERE, by the consumer, rather than imported from port") — and
   **T8** wires it in `main.go`'s existing `&orchestration.Reactor{...}`
   literal (`main.go:463-473`).
3. **`GET /api/agent/attachments/{id}` cannot be used as a plain `<img src>`.**
   The spec's C2 section says `MessagesTimeline` sources thumbnails "directly"
   from that URL, but agent-attachment routes live on a **runtime** machine,
   which is key-only auth: `Authorization: Bearer <key>`, and per
   `CONTRACTS.md`'s key-auth section, `?key=` on a plain (non-WebSocket-
   upgrade) request is rejected with 401 — "keys must not otherwise travel in
   URLs." A bare `<img src="{machine.url}/api/agent/attachments/{id}">` 401s
   on direct-first connections, which are the common path. The hub's own
   `attachmentUrl()` (`lib/api.ts:494-496`) gets away with a bare `<img src>`
   only because the *hub* uses session-cookie auth (sent automatically,
   same-origin); a runtime has no cookie at all. **T11** fetches the bytes
   through `machineXhr` (`responseType: 'blob'`) — the same mechanism
   `downloadWorktreeZipWithProgress` already uses (`machineApi.ts:143-157`) —
   and renders an `URL.createObjectURL(blob)`, not the raw route, as the
   `<img src>`.

One more naming inconsistency, resolved rather than corrected: the spec's C1
section gives `provider.Attachment` the JSON tag `mime` (§"Wire shape",
`provider.go:255-263` as changed), but its C2 section writes
`ChatItem.attachments?: { id, name, mimeType }[]` — a different key for the
same field. **T10** uses `mime` (matching the actual wire tag T3 adds), not
`mimeType`, because `EvtThreadMessageSent`'s payload is the *same*
`TurnStartPayload` object decoded off the socket — there is no separate echo
format to invent a second field name for.

## Dependency shape

Nine of the fifteen tasks have no dependency on anything else in this plan
and can start immediately, in any order, by different agents:

```
Independent at the start (no shared files, any order):
  T1  composerSerialize.ts                          (C0)
  T2  domain + store + port.Store + db + cascade + types.ts mirror   (C1)
  T3  provider.go JSON tags + wire-size regression                  (C1)
  T4  claude adapter image content blocks                           (C1)
  T5  pi adapter explicit-error path                                (C1)
  T9  imageCompression.ts                                           (C2)
  T10 eventReducer.ts + ChatItem.attachments                        (C2)
  T13 Terminal.tsx captureSelection                                 (C3)
  T14 ComposerPromptEditor.tsx insertChip ref                       (C3)

T2 ──┬─▶ T6 handler (agent_attachment.go)     ──┐
     └─▶ T7 reactor load (workers.go)           ├─▶ T8 main.go wiring
                                                 ┘   (routes + Reactor field
                                                      + startup sweep)

T1 ──▶ T12 terminalContext.ts

{T8, T9, T10} ──▶ T11 upload client + ComposerAttachments.tsx +
                   ChatComposer.tsx / AgentChatPane.tsx /
                   MessagesTimeline.tsx / useAgentChatSocket.ts   (1st edit)

{T11, T12, T13, T14} ──▶ T15 ExpandedTerminal.tsx bridge +
                          ChatComposer.tsx / MessagesTimeline.tsx (2nd edit)
```

T3, T4, T5 have no downstream task in this plan — nothing else needs them to
compile or run, they just need to land before C1's commit closes. They can be
done at any point, by any free agent.

**Order constraint carried over from the spec:** C0 before C3 (nothing may
insert the chip before its serialized form is self-delimiting — enforced here
by T12/T15 depending on T1), and C1 before C2 (T11 depends on T8, since C2 is
a client for routes that don't exist before then).

## Convergence files (CLAUDE.md)

`routeTree.gen.ts` and `useDevDeckStore.ts` are untouched by all of subsystem
C. The other three CLAUDE.md-listed convergence files this subsystem *does*
touch are each owned by exactly **one** task — no two tasks in this plan edit
the same convergence file, so no serialization beyond the dependency graph
above is needed:

| Convergence file | Owned by |
|---|---|
| `backend/internal/domain/models.go` | T2 |
| `backend/internal/port/store.go` | T2 |
| `frontend/src/store/types.ts` | T2 |
| `backend/cmd/server/main.go` | T8 |

## The one deliberate exception to single file ownership

`frontend/src/features/agent-chat/ChatComposer.tsx`,
`ChatComposer.test.tsx`, `MessagesTimeline.tsx`, and
`MessagesTimeline.test.tsx` are each edited by **two** tasks — T11 (C2: the
attachment slot, `onSend` arity, image thumbnails) and T15 (C3: the capture
map, the `<terminal_context>` append at submit, stripping it for display).
This is not an oversight: the spec places C2 before C3 *specifically* because
these four files are shared (§"Where this sits"). **T15 must not start until
T11's commit has landed** — never run them in parallel, and never let two
different agents hold them open at once. Every other file in the table below
has exactly one owner.

## File ownership

| Task | Piece | Depends on | Writes |
|---|---|---|---|
| T1 | C0 | — | `composerSerialize.ts`, `composerSerialize.test.ts` |
| T2 | C1 | — | `domain/models.go`\*, `port/store.go`\*, `store/agentattachment.go` (new), `store/agentattachment_test.go` (new), `store/db.go`, `store/agentevent.go`, `frontend/src/store/types.ts`\* |
| T3 | C1 | — | `provider/provider.go`, `provider/provider_test.go`, `orchestration/command_test.go` (new) |
| T4 | C1 | — | `provider/claude/adapter.go`, `provider/claude/driver_test.go` |
| T5 | C1 | — | `provider/pi/adapter.go`, `provider/pi/driver_test.go` |
| T6 | C1 | T2 | `handler/agent_attachment.go` (new), `handler/agent_attachment_test.go` (new) |
| T7 | C1 | T2 | `orchestration/workers.go`, `orchestration/workers_attachment_test.go` (new) |
| T8 | C1 | T6, T7 | `cmd/server/main.go`\* |
| T9 | C2 | — | `agent-chat/imageCompression.ts` (new), `agent-chat/imageCompression.test.ts` (new) |
| T10 | C2 | — | `agent-chat/eventReducer.ts`, `agent-chat/types.ts`, `agent-chat/eventReducer.test.ts` |
| T11 | C2 | T8, T9, T10 | `lib/machineApi.ts`, `agent-chat/ComposerAttachments.tsx` (new), `agent-chat/ComposerAttachments.test.tsx` (new), `agent-chat/ChatComposer.tsx`†, `agent-chat/ChatComposer.test.tsx`†, `agent-chat/AgentChatPane.tsx`, `agent-chat/AgentChatPane.test.tsx`, `agent-chat/useAgentChatSocket.ts`, `agent-chat/useAgentChatSocket.test.ts` (new), `agent-chat/MessagesTimeline.tsx`†, `agent-chat/MessagesTimeline.test.tsx`† |
| T12 | C3 | T1 | `agent-chat/terminalContext.ts` (new), `agent-chat/terminalContext.test.ts` (new) |
| T13 | C3 | — | `terminal/Terminal.tsx`, `terminal/Terminal.test.tsx` (new) |
| T14 | C3 | — | `agent-chat/ComposerPromptEditor.tsx`, `agent-chat/ComposerPromptEditor.test.tsx` |
| T15 | C3 | T11, T12, T13, T14 | `terminal/ExpandedTerminal.tsx`, `terminal/ExpandedTerminal.test.tsx`, `agent-chat/ChatComposer.tsx`†, `agent-chat/ChatComposer.test.tsx`†, `agent-chat/MessagesTimeline.tsx`†, `agent-chat/MessagesTimeline.test.tsx`† |

`\*` = CLAUDE.md convergence file. `†` = the deliberate two-owner exception
described above (T11 first, T15 second — never parallel).

All backend paths are relative to `backend/internal/agentcore/` or
`backend/internal/` as shown; all frontend paths relative to `frontend/src/`.

## Commit granularity

Per the spec's own "Commit granularity" risk note, the pre-commit hook
typechecks the whole project, so C0/C1/C2/C3 each land as **one commit**
regardless of how many TDD tasks compose them:

- **C0** = T1 → 1 commit.
- **C1** = T2–T8 → 1 commit (backend only; frontend's only touch is T2's
  `types.ts` mirror, required by `CONTRACTS.md`'s domain-mirroring rule).
- **C2** = T9–T11 → 1 commit.
- **C3** = T12–T15 → 1 commit.

Tasks within a piece can be built and reviewed independently (that's the
point of the file-ownership table), but they integrate into one commit per
piece, same discipline as the format-model plan.

---

## T1 — C0: terminal-context chip becomes a markdown link (independent)

The join key for C3's `<terminal_context>` block, and it must ship before
anything inserts the chip.

**Tests first**, extending `composerSerialize.test.ts`. **Replace** the
existing (now-wrong) case at `composerSerialize.test.ts:84-86`
(`composerTerminalContextChip('terminal-1:12-13')` → `'@terminal-1:12-13'`)
with the corrected form, plus:
- `composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal 1 lines 12-40')`
  → `'[Terminal 1 lines 12-40](terminal:sess-7f2a/L12-L40)'`.
- A chip immediately followed by text (`…)please`) — the exact case the old
  bare-prefix form got wrong for file chips, now applied to this kind.
- Two adjacent terminal-context chips stay separately readable.
- A label containing `[`/`]` is escaped (reuses `escapeMarkdownLinkLabel`).
- A session key containing a character `encodeURI`/`encodeMarkdownLinkDestination`
  touches (e.g. a space) round-trips through the destination correctly.
- No label supplied: falls back to `value` verbatim as the label (mirrors the
  file chip's basename fallback, but there is no "basename" operation for a
  session key — the whole `value` is the fallback label).

**Then implement**, in `composerSerialize.ts`:
- `CHIP_PREFIX` (`composerSerialize.ts:54-57`) drops its `terminalContext`
  entry — it keeps only `skill: '$'`.
- `serializeInlineNode`'s branch for `node.kind === 'file'` becomes a shared
  branch for `file` **or** `terminalContext`. For `terminalContext`:
  `label = escapeMarkdownLinkLabel(node.label ?? node.value)`,
  `dest = encodeMarkdownLinkDestination('terminal:' + node.value)`. This
  changes `label`'s role for this one kind: it stops being purely
  presentational (the current doc comment's claim) and becomes what actually
  gets serialized when present — update that comment.
- `node.value` for this kind carries no `terminal:` prefix (added at
  serialize time); the bridge that inserts the chip (T15) is responsible for
  passing `value = '<sessionKey>/L<start>-L<end>'`.

**Done when:** `composerSerialize.test.ts` passes, including the replaced
case.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/composerSerialize.test.ts`

---

## T2 — C1: domain type, store, port.Store, migration, cascade delete (independent)

Convergence-file task — touches three CLAUDE.md files in one step per
`CONTRACTS.md`'s "add it to both files simultaneously" rule.

**Tests first**, new `backend/internal/store/agentattachment_test.go`:
- `TestCreateAgentAttachment_RoundTrip` — create, then `AgentAttachmentData`
  returns the same bytes and correct metadata.
- `TestAgentAttachmentData_UnknownID` — returns `store.ErrNotFound`.
- `TestDeleteAgentThread_CascadesAttachments` — seed a thread (via
  `CommitAgentEvents` or a direct row insert, matching this file's existing
  test helpers), create an attachment against it, call `DeleteAgentThread`,
  assert `AgentAttachmentData` now returns `ErrNotFound`.
- `TestDeleteOrphanAgentAttachments` — one attachment whose `thread_id` has
  no `agent_thread` row (swept, count includes it) and one whose `thread_id`
  does (survives).
- `TestCreateAgentAttachment_NoThreadRequired` — creating an attachment
  against a `thread_id` with no existing `agent_thread` row succeeds (this is
  the load-bearing difference from `issue_attachments`' `issueByID` guard —
  see below).

**Then implement:**
- `domain/models.go`: add, near `Attachment` (`models.go:78-87`):
  ```go
  // AgentAttachment mirrors the frontend AgentAttachment type. Raw bytes are
  // fetched separately via GET /api/agent/attachments/{id}. ThreadID may name
  // a thread that does not exist yet — see store/agentattachment.go.
  type AgentAttachment struct {
      ID        string `json:"id"`
      ThreadID  string `json:"threadId"`
      Name      string `json:"name"`
      MimeType  string `json:"mimeType"`
      SizeBytes int64  `json:"sizeBytes"`
      CreatedAt string `json:"createdAt"`
  }
  ```
- `frontend/src/store/types.ts`: the mirror, same field order, camelCase.
- `port/store.go`: three new methods, grouped near the existing
  `AgentThreads`/`DeleteAgentThread` block (`store.go:208-212`):
  ```go
  CreateAgentAttachment(threadID, name, mimeType string, data []byte, createdAt string) (domain.AgentAttachment, error)
  AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error)
  DeleteOrphanAgentAttachments() (int, error)
  ```
- `store/db.go`: new table in the schema string, alongside `agent_thread`/
  `agent_event` (`db.go:351-366`):
  ```sql
  CREATE TABLE IF NOT EXISTS agent_attachment (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    mime_type   TEXT NOT NULL DEFAULT '',
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    data        BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_agent_attachment_thread ON agent_attachment(thread_id);
  ```
  **No `REFERENCES agent_thread(id)`** — deliberately, matching
  `agent_event.thread_id` and `agent_command_receipt.thread_id`, both plain
  `TEXT NOT NULL` with no FK (`db.go:351-375`). Foreign keys are ON
  (`_pragma=foreign_keys(1)`, `db.go:384`); a hard FK would reject an upload
  made before the thread's `EvtThreadCreated` has committed a row, which the
  spec's own "upload immediately, on add" (C2) makes a real, not theoretical,
  ordering. This is why `CreateAgentAttachment` (below) has no `issueByID`-
  style existence guard, unlike `CreateAttachment` (`store/attachment.go:6-9`).
- `store/agentattachment.go` (new): `CreateAgentAttachment`,
  `AgentAttachmentData`, `DeleteOrphanAgentAttachments` — mirror
  `store/attachment.go`'s shape (`CreateAttachment`/`AttachmentData`) minus
  the issue-existence check. `DeleteOrphanAgentAttachments`:
  `DELETE FROM agent_attachment WHERE thread_id NOT IN (SELECT id FROM agent_thread)`,
  return `RowsAffected()`.
- `store/agentevent.go`: `DeleteAgentThread` (`agentevent.go:267-284`) gains
  a fourth statement, `DELETE FROM agent_attachment WHERE thread_id = ?`,
  inside the same transaction, alongside the existing three.

**Done when:** `agentattachment_test.go` passes; `domain/models.go` and
`store/types.ts` match field-for-field per `CONTRACTS.md`.

**Verify:** `cd backend && go test ./internal/store/... && go vet ./internal/store/... ./internal/domain/...`

---

## T3 — C1: `provider.Attachment` gets JSON tags; wire-size regression (independent)

The exact bug class `ModelSelection` was already fixed for
(`provider.go:150-154`'s own comment), applied to `Attachment`.

**Tests first**, `provider_test.go`:
- `TestAttachmentJSONRoundTrip` — `json.Marshal` an `Attachment{ID, Kind,
  MIME, Name}` and assert the output has exactly the keys `id`, `kind`,
  `mime`, `name` — no `Data`/`Path`, no PascalCase. `json.Unmarshal` a
  `{"id":"a-1","kind":"image","mime":"image/png","name":"x.png"}` blob and
  assert the struct fields are populated (this is the literal regression
  test for the untagged-struct defect the spec names).
- New `orchestration/command_test.go`, `TestTurnStartPayload_EightAttachments_Under4KB`
  — build a `TurnStartPayload{Text: "...", Attachments: [8]Attachment{...}}`
  (id/kind/mime/name only, `Data` empty — it's `json:"-"`), `json.Marshal`,
  assert `len(bytes) < 4096`. This is the spec's own named regression guard
  against bytes creeping back into the command (`agent_ws.go:77`'s 1MB frame
  cap).

**Then implement**, `provider.go:181-187`:
```go
type Attachment struct {
    ID   string `json:"id"`
    Kind string `json:"kind"` // "image" | "file"
    MIME string `json:"mime"`
    Name string `json:"name"`
    Data []byte `json:"-"` // filled server-side from the store — see T7
    Path string `json:"-"` // unused today; kept, not serialized
}
```

**Done when:** both new tests pass and every existing caller of
`provider.Attachment` still compiles (it does — only the struct tags change,
no field is renamed or removed).

**Verify:** `cd backend && go test ./internal/agentcore/provider/... ./internal/agentcore/orchestration/... && go vet ./...`

---

## T4 — C1: claude adapter builds image content blocks (independent)

**Tests first**, extending `claude/driver_test.go` (its existing assertions
are the "stays green" regression — add new `Test...` functions alongside
them, do not alter what's already there):
- `TestSendTurn_WithImageAttachment_BuildsContentArray` — a `SendTurnInput`
  with `Text` plus one `Attachment{Kind:"image", MIME:"image/png", Data:
  [...]}` produces a stdin-encoded message whose `content` array is exactly
  `[{"type":"text",...}, {"type":"image","source":{"type":"base64",
  "media_type":"image/png","data":"<base64>"}}]`. Follow this file's existing
  harness for capturing what `SendTurn` writes to `stdin` — same technique
  the pre-existing text-only `SendTurn` test already uses.
- `TestSendTurn_UnsupportedMIME_FailsTurn` — `MIME: "image/svg+xml"` (not in
  the allow-list) returns an error and writes nothing to stdin.

**Then implement**, `claude/adapter.go:393-399`: after building
`content := []map[string]any{{"type":"text","text":in.Text}}`, loop
`in.Attachments`; for each, validate `MIME` against `image/gif`,
`image/jpeg`, `image/png`, `image/webp` (return an error immediately on a
miss, matching t3code's own allow-list per the spec); on a match, append
`{"type":"image","source":{"type":"base64","media_type":a.MIME,"data":
base64.StdEncoding.EncodeToString(a.Data)}}`.

**Done when:** the two new tests pass and every pre-existing assertion in
`claude/driver_test.go` is unchanged and green.

**Verify:** `cd backend && go test ./internal/agentcore/provider/claude/... && go vet ./...`

---

## T5 — C1: pi adapter errors on non-empty attachments (independent)

**Tests first**, extending `pi/driver_test.go` (same "add, don't alter"
rule as T4):
- `TestSendTurn_WithAttachments_Errors` — a `SendTurnInput` with one
  `Attachment` returns an error containing something like "cannot carry
  attachments", and — checked explicitly, since this is the point of doing
  the check first — **no** `TurnStarted` event is emitted and nothing is
  written to the session's stdin.

**Then implement**, `pi/adapter.go:314` (`SendTurn`), immediately after the
session lookup and before `sess.state.setTurnID`/the `TurnStarted` emit:
```go
if len(in.Attachments) > 0 {
    return provider.TurnStartResult{}, fmt.Errorf("pi: this provider cannot carry attachments")
}
```
Placed before any side effect specifically so the failure is clean — no
half-started turn, no wasted `TurnStarted` event the reactor then has to
settle.

**Done when:** the new test passes; every pre-existing `pi/driver_test.go`
assertion stays green.

**Verify:** `cd backend && go test ./internal/agentcore/provider/pi/... && go vet ./...`

---

## T6 — C1: HTTP handler for upload/download (needs T2)

**Tests first**, new `handler/agent_attachment_test.go` — mirror the shape
of the existing attachment handler tests if any exist for
`handler/attachment.go`, otherwise build fresh against `httptest`:
- `TestPostAttachment_Success` — `multipart/form-data`, field `file`, a real
  PNG — 200, body is the `domain.AgentAttachment` JSON (no `data` field).
- `TestPostAttachment_MissingFile400` — no `file` field — 400,
  `{"error":...}` envelope.
- `TestPostAttachment_NonImage400` — a `text/plain` body — 400. This must
  check the **sniffed** content type, not the client-supplied
  `Content-Type` header — a mislabeled upload (wrong header, real image
  bytes) should still be accepted, and a spoofed header (image/png label on
  script bytes) should still be rejected. This is the specific way this
  handler differs from `handler/attachment.go`'s `PostAttachment`
  (`attachment.go:26-56`), which trusts the header verbatim.
- `TestPostAttachment_Oversize400` — a body over the 10MB cap — 400.
- `TestGetAttachment_Success` — 200, correct `Content-Type` from stored
  `mime_type`, `Cache-Control: private, max-age=31536000, immutable`
  (matching `attachment.go:77`, honest here because an id is immutable).
- `TestGetAttachment_UnknownID404` — 404, `{"error":...}` envelope, via
  `handleStoreErr`.

**Then implement**, `handler/agent_attachment.go` (new):
```go
type AgentAttachmentHandler struct{ store port.Store }
func NewAgentAttachmentHandler(st port.Store) *AgentAttachmentHandler
```
(`port.Store`, not `*store.Store` — following `AgentThreadHandler`
(`agent_thread.go:13-23`), the newer convention, not the older
`AttachmentHandler`'s concrete-store field, per the spec's §3.)

`PostAttachment`: `http.MaxBytesReader` at 10MB, `ParseMultipartForm`,
`FormFile("file")`, read the body, `http.DetectContentType(data[:min(512,
len(data))])`, 400 if the sniffed type doesn't start with `"image/"`,
`CreateAgentAttachment(r.PathValue("threadId"), header.Filename, sniffed,
data, time.Now().UTC().Format(time.RFC3339))`, `handleStoreErr`, 200.

`GetAttachment`: `AgentAttachmentData(r.PathValue("id"))`, `handleStoreErr`,
set `Content-Type`/`Cache-Control`, write the bytes.

**Done when:** all six tests pass.

**Verify:** `cd backend && go test ./internal/handler/... && go vet ./...`

---

## T7 — C1: reactor loads attachment bytes before `SendTurn` (needs T2)

This is where the correction in this plan's opening section applies —
`Reactor` needs a new field, not just a new step in an existing one.

**Tests first**, new `orchestration/workers_attachment_test.go`:
- `TestReact_TurnStart_LoadsAttachmentBytes` — a stub `AttachmentReader`
  returning fixed bytes for a known id; a stub `provider.Service`/adapter (or
  whatever fake this package's existing tests use — follow
  `workers_reactor_test.go`'s own harness) capturing the `SendTurnInput` it
  receives; dispatch a turn-start with one `Attachment{ID:"a-1"}` and no
  `Data`; assert the captured input's `Attachments[0].Data` equals the stub's
  bytes.
- `TestReact_TurnStart_AttachmentLoadFailure_ReportsError` — the stub
  returns an error; assert `SendTurn` is never called and the failure
  surfaces through the existing `reportError` path (same mechanism
  `workers_reactor_test.go`'s existing error-path tests already exercise —
  reuse it, don't reinvent).
- `TestReact_TurnStart_NoAttachmentReader_SkipsLoading` — `Reactor.Attachments`
  left `nil` (zero value) and a turn with **no** attachments still calls
  `SendTurn` normally. This is what keeps every pre-existing
  `workers_test.go`/`workers_reactor_test.go` construction of a bare
  `Reactor{}` literal compiling and passing unmodified.

**Then implement**, `workers.go`:
- Add, near the top of the file (mirroring `portstore.go`'s `EventStore`
  doc-comment pattern):
  ```go
  // AttachmentReader is the narrow slice of persistence the Reactor needs to
  // resolve an attachment id into bytes before handing it to the provider —
  // declared here, not imported from port, mirroring portstore.go's
  // EventStore. domain.AgentAttachment matches store.Store's method exactly,
  // so the concrete store satisfies this with no adapter.
  type AttachmentReader interface {
      AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error)
  }
  ```
  (New import: `devdeck/backend/internal/domain` — not currently imported by
  this package; verified no cycle risk, `domain` has no imports back into
  `orchestration`.)
- Add `Attachments AttachmentReader` to the `Reactor` struct
  (`workers.go:322-343`).
- In the `EvtThreadTurnStartRequested` case (`workers.go:442-478`), before
  the `r.Provider.SendTurn(...)` call: if `r.Attachments != nil`, loop
  `p.Attachments`, for each call `r.Attachments.AgentAttachmentData(a.ID)`;
  on error, return it immediately (propagates to the existing `reportError`
  path in `loop`, `workers.go:381-386`); on success, set `p.Attachments[i].Data
  = data`.

**Done when:** all three new tests pass and `workers_test.go` /
`workers_reactor_test.go` are unchanged and green.

**Verify:** `cd backend && go test ./internal/agentcore/orchestration/... && go vet ./...`

---

## T8 — C1: main.go integration — routes, Reactor wiring, startup sweep (needs T6, T7)

Convergence-file task, and the point where C1 becomes runnable end-to-end.

**No new dedicated test file** — route wiring in `main.go` is verified by the
existing smoke/integration tests staying green plus a manual build. If a
gap is found here that only an end-to-end test would catch, prefer extending
`handler/agent_smoke_test.go` over adding a parallel file no other task
tracks.

**Then implement:**
- Construct the handler near the other handler constructions
  (`main.go` around `attH := handler.NewAttachmentHandler(st)`, ~line 359):
  `agentAttachmentH := handler.NewAgentAttachmentHandler(st)`.
- Register two routes near the existing agent-thread routes
  (`main.go:856-857`):
  ```go
  mux.HandleFunc("POST /api/agent/threads/{threadId}/attachments", agentAttachmentH.PostAttachment)
  mux.HandleFunc("GET /api/agent/attachments/{id}", agentAttachmentH.GetAttachment)
  ```
- Wire the Reactor (`main.go:463-473`): add `Attachments: st,` to the
  `&orchestration.Reactor{...}` literal — `*store.Store` (via `st`)
  structurally satisfies T7's new `AttachmentReader` interface, no adapter
  needed.
- Startup orphan sweep: near `st := store.New(db)` (`main.go:227`), on every
  role (not gated by `!isRuntime` — attachments are per-machine, chat runs on
  runtimes too):
  ```go
  if n, err := st.DeleteOrphanAgentAttachments(); err != nil {
      log.Printf("agent attachments: startup sweep failed: %v", err)
  } else if n > 0 {
      log.Printf("agent attachments: swept %d orphaned upload(s)", n)
  }
  ```

**Done when:** `go build ./...` succeeds; `agent_smoke_test.go` and
`agent_ws_test.go` are unchanged and green; a manual `curl` round-trip
(upload then fetch) against a locally running `--role both` instance works.

**Verify:** `cd backend && go build ./... && go vet ./... && go test ./internal/handler/... ./internal/agentcore/...`

**This closes C1.** One commit: T2–T8.

---

## T9 — C2: `imageCompression.ts` downscale ladder (independent)

Pure module, no dependency on anything else in this plan.

**Tests first**, new `imageCompression.test.ts`. This repo has no existing
canvas-mocked test to follow as precedent — say so plainly rather than
inventing a fake one — so mock whichever browser API the implementation ends
up using (`HTMLCanvasElement.prototype.getContext`/`toBlob`, or
`createImageBitmap`, whichever this port settles on) at the behavior level,
not pixel-accuracy:
- A source file over 50MB is rejected before any decode is attempted (assert
  the mocked decode API was never called).
- A decoded image whose longest edge exceeds 2048px is downscaled; the
  quality ladder is tried in order `[0.92, 0.85, 0.78, 0.68]`, stopping at
  the first attempt that satisfies whatever size target the implementation
  is checking against.
- Exhausting the quality ladder without success falls through to the two
  scale-reduction steps.
- A file already under every threshold passes through with no re-encode.

**Then implement:** `downscaleImage(file: File): Promise<File>` — the
values above, longest-edge target 2048px, quality steps
`[0.92, 0.85, 0.78, 0.68]`, then two fallback scale-reduction steps, 50MB
source cap. Reject (don't silently truncate) above the cap — decoding
hundreds of megapixels can OOM the tab, per the spec's own reasoning.

**Done when:** `imageCompression.test.ts` passes.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/imageCompression.test.ts`

---

## T10 — C2: `eventReducer.ts` folds `attachments`; `ChatItem` gains the field (independent)

Pure reducer work — needs only the documented wire shape, not a running
backend.

**Tests first**, extending `eventReducer.test.ts`:
- A `thread.message-sent` event whose payload is
  `{text, attachments:[{id,kind,mime,name}]}` produces a `ChatItem` with
  `.attachments` populated with exactly that array.
- The existing message-sent-without-attachments case is unchanged:
  `.attachments` stays `undefined` (not `[]`) — do not touch its assertion.

**Then implement:**
- `types.ts`: `ChatItem` gains
  `attachments?: { id: string; kind: string; mime: string; name: string }[]`.
  Field names deliberately match `provider.Attachment`'s JSON tags exactly
  (`id`/`kind`/`mime`/`name`, **not** `mimeType`) — see this plan's opening
  "naming inconsistency" note: `EvtThreadMessageSent`'s payload is the same
  `TurnStartPayload` object decoded off the socket, there is no separate echo
  shape.
- `eventReducer.ts`: extend `MessageSentPayload`/`isMessageSentPayload`
  (`eventReducer.ts:52-59`) to optionally carry `attachments`; in the
  `thread.message-sent` branch (`eventReducer.ts:280-286`), thread
  `event.payload.attachments` onto the created item.

**Done when:** `eventReducer.test.ts` passes, including the untouched
existing case.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts`

---

## T11 — C2: upload client + composer/timeline wiring (needs T8, T9, T10)

The integration task for C2 — first of the two edits to `ChatComposer.tsx`
and `MessagesTimeline.tsx` (see "the one deliberate exception," above).

**Tests first:**
- New `ComposerAttachments.test.tsx`: renders one thumbnail per pending
  attachment; the remove control calls its handler; a pending attachment
  mid-upload shows a progress affordance (the loading state
  `.claude/rules/frontend.md` requires); a failed upload shows an explicit
  error affordance (the error state) and leaves the item in the list rather
  than silently dropping it.
- `ChatComposer.test.tsx` (extend — this is a **required**, compilation-
  forcing update, not optional: `onSend`'s arity is widening from
  `(text) => void` to `(text, attachments) => void`, so every existing call
  site in this test file that asserts on `onSend`'s call must be updated to
  expect the second argument, empty array when nothing was attached): add
  `data-slot="composer-attachments"` renders as a sibling of
  `data-slot="composer-panels"` (never inside it — A's slot stays reserved,
  `ChatComposer.tsx:189-191`); the paperclip button opens a file picker that
  feeds the same `addFiles` path as paste/drop.
- `AgentChatPane.test.tsx` (extend): the mocked `sendTurn` (this file already
  fully mocks `useAgentChatSocket`, confirmed via its `vi.mock` at line 8) is
  called with the attachments array `ChatComposer`'s `onSend` forwarded.
- New `useAgentChatSocket.test.ts` — this hook currently has **no** dedicated
  test file (confirmed: not in the existing `agent-chat/*.test.ts(x)`
  listing), and `AgentChatPane.test.tsx` mocks it away entirely, so nothing
  today exercises the real dispatch path. Mock the global `WebSocket` and
  `machineWsUrl`; assert `sendTurn(text, model, attachments)` dispatches a
  `thread.turn.start` command whose payload includes `attachments` when
  provided and omits the key entirely when not (matching the existing
  `model` omission precedent at `useAgentChatSocket.ts:311-319`).
- `MessagesTimeline.test.tsx` (extend): a user `ChatItem` with `.attachments`
  renders one thumbnail per entry, each an `<img>` whose `src` is an object
  URL (see T11's implementation note below) — not the raw
  `/api/agent/attachments/{id}` path.

**Then implement:**
- `lib/machineApi.ts`: two new functions.
  ```ts
  export function uploadAgentAttachment(
    machine: Machine, threadId: string, file: File,
    onProgress: (progress: TransferProgress) => void,
  ): Promise<AgentAttachment> {
    const form = new FormData()
    form.append('file', file)
    return machineXhr<AgentAttachment>(machine, {
      method: 'POST',
      path: `/agent/threads/${threadId}/attachments`,
      body: form,
      onUploadProgress: onProgress,
      responseType: 'json',
    })
  }

  export function fetchAgentAttachmentBlob(machine: Machine, id: string): Promise<Blob> {
    return machineXhr<Blob>(machine, {
      method: 'GET',
      path: `/agent/attachments/${id}`,
      responseType: 'blob',
    })
  }
  ```
  (Mirrors `uploadWorktreeFileWithProgress`/`downloadWorktreeZipWithProgress`,
  `machineApi.ts:121-137,143-157` — same `machineXhr` direct-first/proxy
  routing. `fetchAgentAttachmentBlob` is what T11 uses instead of a bare
  `<img src>` — see this plan's opening correction #3.)
- `ComposerAttachments.tsx` (new): owns local `PendingAttachment` state
  (file, upload progress, uploaded id, or error), the `addFiles(FileList)`
  entrypoint (wired to paste/drop on the composer surface and the paperclip
  button), calls T9's `downscaleImage` before `uploadAgentAttachment`. Maps
  down to `{id, kind:'image', mime, name}[]` (T10's shape) at send time.
- `ChatComposer.tsx`: renders `<ComposerAttachments />` under
  `data-slot="composer-attachments"`, between `composer-panels` and the
  editor; `onSend` becomes `(text: string, attachments: AgentAttachmentRef[]) => void`;
  clears both text and the attachment list on submit. Paperclip button in the
  footer next to the existing controls (not inside `ComposerControls.tsx`,
  which this task does not touch, per the spec). Also implements the Risk
  note's gating: disables the paperclip (with a tooltip) when the thread's
  effective agent is `pi` — `(model?.agentId ?? agentId) === 'pi'`, both
  already available via `AgentChatPane`'s existing `controls`/`agentId`
  plumbing.
- `AgentChatPane.tsx`: `onSend={(text, attachments) => sendTurn(text,
  turnModel(model, effort, contextWindow), attachments)}`.
- `useAgentChatSocket.ts`: `sendTurn(text, model?, attachments?)` →
  `dispatch('thread.turn.start', {text, ...(model ? {model} : {}),
  ...(attachments?.length ? {attachments} : {})})`.
- `MessagesTimeline.tsx`: `MessageRow`'s user branch renders a thumbnail
  strip when `item.attachments` is non-empty. Each thumbnail: fetch via
  `fetchAgentAttachmentBlob`, `URL.createObjectURL`, revoke on unmount — a
  small dedicated component so the fetch/revoke lifecycle isn't duplicated
  per-thumbnail inline.

**Done when:** all five test files pass; `ChatComposer.test.tsx`'s
non-attachment assertions (Enter-to-send, the interrupt/send button swap,
etc.) are unchanged and green.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/ComposerAttachments.test.tsx src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/AgentChatPane.test.tsx src/features/agent-chat/useAgentChatSocket.test.ts src/features/agent-chat/MessagesTimeline.test.tsx && npm run typecheck`

**This closes C2.** One commit: T9–T11.

---

## T12 — C3: `terminalContext.ts` (needs T1)

Pure port of t3code's `buildTerminalContextBlock`/`extractTrailingTerminalContexts`
(`terminalContext.ts:159-182,223-246` in t3code — reference only, do not
edit that tree).

**Tests first**, new `terminalContext.test.ts`:
- `buildTerminalContextBlock` — given one or more captured contexts (each
  `{destination, label, text}`), produces a trailing block whose per-entry
  header matches the destination format T1 defines
  (`terminal:<sessionKey>/L<start>-L<end>`).
- `extractTrailingTerminalContexts` round-trips: build a block, extract it
  back, get the same entries; and strips it from the visible text (the
  `visibleText`/`copyText` split, mirroring t3code's own split).
- **The join-key property** — this plan's load-bearing test, named directly
  by the spec: every link destination that appears in a serialized message
  (T1's markdown-link form) has a matching block-header entry appended by
  `buildTerminalContextBlock`, and vice versa — no destination without a
  block entry, no block entry without a destination in the text.
- A message with no terminal-context chips: `buildTerminalContextBlock`
  returns the text unchanged (no trailing block appended).

**Then implement:** `buildTerminalContextBlock(text: string, contexts: {
destination: string; text: string }[]): string` and
`extractTrailingTerminalContexts(text: string): { visibleText: string;
copyText: string; contexts: {...}[] }`, following t3code's split as
described in the spec (§"Display must strip it").

**Done when:** `terminalContext.test.ts` passes, including the join-key
property test.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/terminalContext.test.ts`

---

## T13 — C3: `Terminal.tsx` gains `captureSelection` (independent)

No existing `Terminal.test.tsx` in this repo — this is first coverage for
the component, not an extension of anything.

**Tests first**, new `Terminal.test.tsx`. `ExpandedTerminal.test.tsx`
already mounts `Terminal` under jsdom (xterm's WebGL addon already fails
gracefully there per `Terminal.tsx:216-222`'s own try/catch) — follow that
file's mounting setup rather than inventing a new one:
- A selection made via xterm's `select()`/programmatic selection API
  produces `captureSelection()` returning `{ text, sessionKey, startLine,
  endLine }` with the correct 1-indexed line range (`getSelectionPosition()`
  returns an `IBufferRange` — real line numbers, per the design spec).
- No selection: `captureSelection()` returns `null`.
- A "Send to chat" affordance appears only while a selection exists, driven
  by xterm's `onSelectionChange` (`xterm.d.ts:996`), and disappears when the
  selection is cleared.

**Then implement**, `Terminal.tsx`:
- `TerminalHandle` (`Terminal.tsx:26-32`) gains
  `captureSelection: () => TerminalContextSelection | null`.
- Built from `term.getSelection()` (text) and `term.getSelectionPosition()`
  (line range); `sessionKey` is this component's own `session` prop.
- A small state-driven affordance (visible only while
  `term.hasSelection()`/`onSelectionChange` reports a non-empty selection).

**Done when:** `Terminal.test.tsx` passes.

**Verify:** `cd frontend && npx vitest run src/features/terminal/Terminal.test.tsx`

---

## T14 — C3: `ComposerPromptEditor.tsx` imperative `insertChip` (independent)

The trap the spec names directly: the external-value effect
(`ComposerPromptEditor.tsx:213-218`) must not clobber an inserted chip.

**Tests first**, extending `ComposerPromptEditor.test.tsx` (existing
assertions — Enter-to-send, the mention menu's Enter-capture, `$`/`/` staying
literal — are the regression; add new cases alongside them):
- `ref.insertChip('terminalContext', 'sess-1/L1-L2', 'Terminal 1 lines
  1-2')` inserts a `composerTerminalContextChip` node at the cursor and
  fires `onChange` with a value containing the chip's serialized form
  (T1's markdown-link output).
- **The trap, tested directly:** after `insertChip` fires (which updates
  `lastValue.current` via the existing `onUpdate` → `onChange` → parent
  `value` round-trip, per the file's own doc comment on this exact
  mechanism), a re-render with the *same* `value` the parent now holds does
  **not** call `editor.commands.setContent` again — i.e. the chip stays in
  the document; it is not clobbered by the external-value effect's guard
  (`lastValue.current === value`) firing a stale `setContent`.
- Removing the inserted chip (via its own remove control, already wired by
  T3 of the shell-editor plan) updates `value` to no longer contain the
  chip's serialized form.

**Then implement:** expose a `ref` (the component currently returns a plain
element, no `forwardRef` — add one) with `insertChip(kind: ComposerChipKind,
value: string, label?: string): void`, calling
`editor.commands.insertContent({ type: composerChipNodeName(kind), attrs: {
value, label } })` (or the editor command equivalent that fires the same
`onUpdate` path plain typing does — this is what keeps `lastValue.current`
and the parent's `value` in agreement, per the file's own doc comment on
that guard).

**Done when:** `ComposerPromptEditor.test.tsx` passes, including every
pre-existing case, unchanged.

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/ComposerPromptEditor.test.tsx`

---

## T15 — C3: the bridge — `ExpandedTerminal.tsx`, and the second edit to `ChatComposer.tsx`/`MessagesTimeline.tsx` (needs T11, T12, T13, T14)

**T11 must already be committed before this task starts** — see "the one
deliberate exception to single file ownership," above.

**Tests first:**
- `ExpandedTerminal.test.tsx` (extend): capturing a selection while a
  terminal pane is focused routes it to "the most recently focused agent-chat
  tab in this worktree's layout"; if none exists, one is opened (reusing
  `openAgentChatThread`'s existing "open or refocus" behavior,
  `ExpandedTerminal.tsx:695-714`); tracking last-focused-chat is exercised by
  focusing a chat tab, switching to a terminal tab, then capturing — the
  captured context reaches the chat tab that was focused *before* the
  terminal, not whichever tab happens to be `layout.focusedPaneId` at capture
  time (which is always the terminal at that moment, per the spec's own
  framing of why this needs a tracked field, not a derived one).
- `ChatComposer.test.tsx` (second edit, additive to T11's): submitting with
  one or more terminal-context chips present in the editor appends a
  `<terminal_context>` block (via T12's `buildTerminalContextBlock`) to the
  text passed to `onSend`; removing a chip before submit removes its entry
  from the appended block (the join-key property, exercised end-to-end this
  time, not just at the pure-function level).
- `MessagesTimeline.test.tsx` (second edit, additive to T11's): a user
  message containing a trailing `<terminal_context>` block renders only the
  visible text (via T12's `extractTrailingTerminalContexts`) plus a
  collapsible affordance showing the context count; expanding it, or
  copying the message, yields the full text including the stripped block.

**Then implement:**
- `ExpandedTerminal.tsx`: `pendingTerminalContext` state keyed by thread,
  passed down to `AgentChatPane` → `ChatComposer`. A new field tracking the
  last-focused agent-chat pane id, updated wherever `focusedPaneId` already
  is (`ExpandedTerminal.tsx:356,400-408,494-498`, etc. — same places, one
  more field written alongside). Terminal panes call `TerminalHandle`'s
  `captureSelection()` (T13) on the "Send to chat" affordance's click,
  resolve the target chat pane per the rule above, and call
  `editor.insertChip('terminalContext', ...)` (T14) through whatever ref
  path reaches that pane's `ComposerPromptEditor`.
- `ChatComposer.tsx` (second edit): a capture map from chip `value` →
  captured `{destination, text}` (populated by whatever inserted the chip —
  the bridge above); on submit, read `editor.getJSON()`, keep the
  `terminalContext` chips in document order, look each up in the capture
  map, and call T12's `buildTerminalContextBlock` before invoking `onSend`.
- `MessagesTimeline.tsx` (second edit): `MessageRow`'s user-text branch runs
  T12's `extractTrailingTerminalContexts` before rendering, shows the
  `visibleText`, and a collapsible row for the stripped contexts; the copy
  action (`MessageFooter`, `MessagesTimeline.tsx:120-139`, whichever branch
  now applies to user rows) uses `copyText` (the full text) not
  `visibleText`.

**Done when:** all three test files pass, including their T11-era
assertions, unchanged.

**Verify:** `cd frontend && npx vitest run src/features/terminal/ExpandedTerminal.test.tsx src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/MessagesTimeline.test.tsx && npm run typecheck`

**This closes C3.** One commit: T12–T15.

---

## C4 — element context: not scheduled

No tasks in this plan. Per the spec's §6, unchanged: browser tiles are
native Tauri webviews (`browserTilesBridge.ts:1-6`), so element picking is
desktop-only with no web story at all; the injection channel exists
(`browser_tiles.rs:328-365`) but the signal that makes a pick useful —
react-grab's `componentName`/`file:line` — has no DevDeck counterpart, so
every pick today would yield a tag name and an HTML blob. Revisit when
either a source-mapping story exists or a non-Tauri browser surface does.

---

## Review, fix, finalize

Run once, over the whole change — not per task, matching the format model.

**Review lenses (parallel):**
- Spec conformance, including the three corrections and one naming fix this
  plan makes explicit above — confirm they landed as described, not as the
  spec originally wrote them.
- TDD honesty: do the tests in each task actually constrain the behavior
  (would they fail against a wrong implementation), or are they written to
  pass?
- The two-owner exception (`ChatComposer.tsx`/`MessagesTimeline.tsx`): confirm
  T15's edits compose cleanly with T11's rather than reverting them.
- The 1MB frame / event-log-replay risk named in the spec's Risks section:
  confirm no path reintroduces raw bytes into the `thread.turn.start`
  command (T3's 4KB regression test is the automated guard; review checks
  nothing bypasses it).
- Regression risk across every file in the "must stay green, unmodified"
  lists from the spec's Testing section.

**Fix:** apply confirmed findings only.

**Finalize:**
- `cd backend && go vet ./... && go test ./...`
- `cd frontend && npm run typecheck && npm test`

## Known-good baseline (restated)

`npm test` (frontend) has **one** pre-existing failure, in the monaco guard
test — not from this work, not to be fixed here. A second failure after any
task lands is a real regression. The backend has **zero** pre-existing
failures on this working tree as of 2026-08-15 (`go build ./...`, `go vet
./...`, and the agentcore/store/handler package tests all pass) — treat any
backend failure introduced by T2–T8 as real, full stop, with no baseline
exception to lean on.
