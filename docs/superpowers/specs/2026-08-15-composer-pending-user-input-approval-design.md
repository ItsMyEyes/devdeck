# Composer — Pending User-Input & Approval Panels

> Spec 1a. Follows `2026-08-14-composer-shell-tiptap-editor-design.md` (subsystem G),
> which shipped the empty slot this spec fills.
>
> Subsystem **A** of the composer decomposition. It is the first composer spec
> with a backend, and most of it *is* backend: the panels are ~350 lines of
> React sitting on top of a control channel that does not exist yet.

## Where this sits

The decomposition table from the G spec, updated:

| | Subsystem | Backend needed | State |
|---|---|---|---|
| **G** | Shell + prompt editor + controls | none | **landed** (`ChatComposer.tsx`, `ComposerPromptEditor.tsx`) |
| **A** | Pending user-input & approval panels | CLI control protocol, approval broker | **this spec** |
| **F** | Banner stack | none | not started |
| **B** | Plan surface (`ProposedPlanCard`) | `ExitPlanMode` intercept, `thread.proposedPlans` | not started |
| **C** | Context attachments | attachment store, terminal→composer bridge | not started |
| **D** | Command menu (`/`, `$`) | per-provider skill/command catalog | not started |
| **E** | Draft threads & prompt stash | none | not started |

**A depends on G, and only on G.** The mount point exists:
`ChatComposer.tsx:189-191` is a literal `<div data-slot="composer-panels" />`
with a comment naming this spec. Nothing else in the composer needs to change.

**A is split into two deliverables that land separately.**

| | Scope | Blast radius of a bug | Order |
|---|---|---|---|
| **A1** | `AskUserQuestion` — the agent asks a multiple-choice question | a wrong string reaches the model | **first** |
| **A2** | `can_use_tool` — the agent asks permission to act | a capability the operator did not grant | second |

A1 first because it exercises **every seam** — CLI stdout → parser → canonical
event → Ingestion → engine → WebSocket → reducer → panel → command → decider →
Reactor → Service → adapter → CLI stdin — with the security-critical decision
replaced by a string. A2 then changes only the semantics at the two ends. Doing
A2 first means debugging fourteen seams and a permission model at once.

There is one coupling that forces A1 to carry a piece of A2, and it is not
optional; see §2.0.

## Problem

Nine defects, all verified against the working tree. They fall into three
groups: the wire is not read, the wire is not written, and the payload never
leaves the backend.

### The request never becomes an event

**`control_request` is discarded as a warning.** `parse.go:183-190` — the
`default:` arm of `parseLine`'s type switch names `"control_request"` in its own
comment and then drops it into `warning(...)`. The comment is honest about being
a placeholder ("Approval handling ships in spec 2"). Every permission prompt and
every question the CLI asks currently lands in the transcript as
`unrecognized message type "control_request"`.

**`system/permission_denied` is dropped entirely, not even as a warning.**
`parse.go:200-203` — `parseSystem` returns `nil` for every subtype that is not
`"init"`. That is the message the CLI emits *today* when a tool is refused
(capture `e1_default`), so the current user-visible signal for "the agent was
blocked" is nothing at all: the transcript shows the tool call, then silence,
then a normal turn completion.

### The answer can never be written

**The broker is a no-op.** `approval/broker.go:35-38` — `NoopBroker.Resolve`
returns `ErrUnknownRequest` unconditionally and `CancelThread` does nothing. It
is wired into both directions in production: `main.go:445-446` (Ingestion) and
`main.go:463-464` (Reactor).

**The claude adapter's two respond methods are `return nil`.**
`adapter.go:428-430` (`RespondToRequest`) and `adapter.go:434-436`
(`RespondToUserInput`). Both carry the same doc comment — "no-op in spec 1".

**`provider.Service` cannot route user-input at all.** The `Adapter` interface
declares `RespondToUserInput` (`provider.go:220`), but `Service` implements only
`SendTurn`, `RespondToRequest`, `InterruptTurn` and `adapterFor`
(`provider.go:353-382`). There is no `Service.RespondToUserInput`.

**The Reactor has no user-input case.** `command.go:136` lists
`EvtThreadUserInputResponseRequested` in `IntentEvents`; `engine.go:151-168`
emits it; `applyOne` clears the pending bit for it (`engine.go:272-284`). But
`react`'s switch (`workers.go:433-543`) handles `EvtThreadCreated`,
`EvtThreadTurnStartRequested`, `EvtThreadApprovalResponseRequested`,
`EvtThreadTurnInterruptRequested`, `EvtThreadSessionStopRequested` — and nothing
else. Answering a question therefore falls through to `return nil`: **the
pending flag clears, the thread flips from `waiting` back to `running`, and the
provider is never told anything.** The agent stays blocked forever while the UI
says it is working. This is the single most dangerous existing gap, because it
looks like it works.

### The payload never reaches the client

**Ingestion forwards the request id and nothing else.** `workers.go:113-127` —
the `RequestOpened, UserInputRequested` case flushes, dispatches
`CmdThreadSessionSet` with `{status: waiting, pendingRequestAdd: <requestID>}`,
and **returns**. It never falls through to the `default:` arm that forwards the
whole canonical envelope as activity. So `RequestOpenedPayload.Detail`,
`.Args`, `.Options` and `UserInputRequestedPayload.Questions` — all of which
exist as typed fields (`event.go:230-273`) — are computed by nobody and
delivered to nobody.

The client side matches: `eventReducer.ts:266-303` reads a status off
`thread.session-set` (`sessionStatusOf`, `eventReducer.ts:90-94`) and drops
`pendingRequestAdd` on the floor. `AgentThreadView` (`types.ts:52-68`) has no
pending-request field. A `waiting` thread renders exactly like a `running` one.

### Two beliefs in the code that the capture disproves

**Correction 1 — approval-required is not an "ask" mode today, it is a
silent-denial mode.** `adapter.go:170-173` says: *"approval-required: leave the
CLI's default in place, every tool call asks for approval … until then the
adapter still asks, it just has nothing to say yes with."*

That is false. With DevDeck's exact `buildArgs` output (capture `e1_default`,
args logged verbatim: `--print --output-format stream-json --input-format
stream-json --verbose --include-partial-messages`) the CLI emits **no
`control_request` at all**. It emits:

```json
{"type":"system","subtype":"permission_denied","tool_name":"Write",
 "tool_use_id":"toolu_0124…","message":"Claude requested permissions to write to
 /…/hello.txt, but you haven't granted it yet."}
```

followed by a synthetic `user` tool_result with `is_error:true` and
`tool_result_meta[].non_execution_kind:"user-rejected"`. Nothing asks. The
adapter has nothing to say yes *to*.

**Correction 2 — plan mode currently runs with no `ExitPlanMode` tool.**
`adapter.go:158-162` maps `InteractionPlan` to `--permission-mode plan`. The
`system/init` tool list differs by exactly three entries between a run with and
without `--permission-prompt-tool stdio` (captures `e3_deny` vs `e9_ask_nostdio`,
otherwise identical): `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` are
present only with the flag. In `e9` the model explicitly reported it had no such
tool. So DevDeck's Plan pill produces a mode the agent cannot leave, and
`AskUserQuestion` — the thing A1 is built for — is not even offered to the model.

**The fix for both is one flag DevDeck does not pass: `--permission-prompt-tool stdio`.**

## Non-goals

- **The plan surface (B).** A2 recognizes `ExitPlanMode` and answers it safely
  (§4.6); it does not render `ProposedPlanCard`, does not add
  `thread.proposedPlans`, and does not let the operator approve a plan.
- **Any permission-rule editor or settings UI.** `acceptForSession` echoes the
  CLI's own `permission_suggestions` back verbatim (§4.3). DevDeck never
  composes a rule, and never writes `~/.claude/settings.json`.
- **The other control subtypes.** The CLI's embedded schema documents
  `set_permission_mode`, `set_model`, `request_user_dialog`, and a
  `pending_permission_requests` list on the `initialize` response
  (`capture/strings.txt`). All are named in §6 and none are built. In
  particular, DevDeck sends no `initialize` handshake today and this spec does
  not add one.
- **Providers other than claude.** `pi`'s `RespondToRequest`/`RespondToUserInput`
  stay no-ops (`pi/adapter.go:387-399`), which the Reactor already tolerates by
  design (`workers.go:487-496`).
- **Turning on buffered delivery.** See §6.
- **A multi-request queue UI.** Both panels render the head of the queue with an
  `n/m` counter, matching t3code.
- **Any DevDeck-side auto-approval heuristic.** DevDeck never decides `allow` on
  the operator's behalf. The only automatic answer this spec introduces is a
  `deny` (§2.0), and it exists to preserve today's behaviour, not to create a
  policy.

## Design

### 0. The wire, as captured

Authoritative source: `claude --version` == **2.1.233**, captures under
`scratchpad/capture/` (harness `drive.py`, per-run `stdout.ndjson` + `log.txt`,
mode matrix `matrix.out`). Everything below was observed, not inferred.

**The flag.** `--permission-prompt-tool stdio`. `"stdio"` is a magic literal;
any other value is looked up as an MCP tool name and the session dies —
`--permission-prompt-tool bogus_tool` produced stderr `Error: MCP tool
bogus_tool (passed via --permission-prompt-tool) not found. Available MCP tools:
none` and **exit code 1** (`e13_bogus_ppt`). Corroborated statically: the CLI
ships the SDK's own arg builder with `"--permission-prompt-tool"` immediately
followed by `"stdio"` (`capture/strings.txt:583519-583520`).

**Which modes actually prompt** (`matrix.out`, one Bash + one Write per run):

| `--permission-mode` | `init.permissionMode` | prompts? |
|---|---|---|
| *(omitted)* | `default` | **yes** |
| `manual` | **`default`** — alias, the CLI renames it | **yes** |
| `plan` | `plan` | **yes** (ExitPlanMode, then the tool) |
| `acceptEdits` | `acceptEdits` | edits no; **non-edit yes** (WebFetch prompted, `e7`) |
| `auto` | `auto` | no (Write/Bash/WebFetch all auto-approved, `e12`) |
| `bypassPermissions` | `bypassPermissions` | no |
| `dontAsk` | `dontAsk` | no — **auto-denies**, `decision_reason_type:"mode"` |
| any of the above, **without** the stdio flag | as above | no — auto-denies |

Mapped onto `provider.RuntimeMode` (`provider.go:115-118`): only
**approval-required** (which is the CLI's `default`, since `buildArgs`'
`default:` arm passes no flag) and **plan** ever prompt. `auto-accept-edits`
prompts only for non-edit tools. `full-access` never prompts.

`Bash echo hi` never prompted in any mode — the CLI's built-in safe-command
classifier auto-approves it. Any test that needs a Bash prompt must use a
side-effecting command.

**Request shape.** `request_id` is **top-level**, not inside `request`
(`e2_ppt_stdio`, verbatim):

```json
{"type":"control_request","request_id":"a83ac130-…","request":{
  "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
  "input":{"file_path":"/…/hello.txt","content":"hi"},
  "description":"hello.txt",
  "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
  "tool_use_id":"toolu_016eNRCDjMVHATeG26UbNTF9"}}
```

Bash adds `blocked_path` and three suggestion kinds — `addRules`,
`addDirectories`, `setMode` (`e15_bash`); WebFetch's rule is
`{"toolName":"WebFetch","ruleContent":"domain:example.com"}` (`e7`).

**Response shape.** Echo the top-level `request_id`:

```json
{"type":"control_response","response":{"subtype":"success",
  "request_id":"<echo>","response":{ …PermissionResult… }}}
```

| PermissionResult | Verified effect |
|---|---|
| `{"behavior":"allow","updatedInput":{…}}` | tool runs (`e2`) |
| `{"behavior":"allow"}` — no `updatedInput` | **also works**, original input used (`e11_allowbare`) |
| `{"behavior":"deny","message":"…"}` | `tool_result` `is_error:true`, content = the message verbatim, `non_execution_kind:"permission-rule"` (`e3_deny`) |
| `+ "updatedPermissions":[<echo permission_suggestions>]` | **"don't ask again" works** — two sequential Writes produced exactly one `control_request` (`e14_persist`) |

That is a 1:1 fit for `event.Decision` (`event.go:253-258`), and the same
mapping t3code uses (`ClaudeAdapter.ts:4033-4051`).

**`AskUserQuestion` rides the same channel.** Same `subtype:"can_use_tool"`;
the discriminators are `tool_name:"AskUserQuestion"` **and**
`"requires_user_interaction": true`, plus the absence of `description` and
`permission_suggestions` (`e4_askuser`):

```json
{"type":"control_request","request_id":"f327a720-…","request":{
  "subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
  "input":{"questions":[{"question":"Do you prefer tabs or spaces for indentation?",
    "header":"Indentation",
    "options":[{"label":"Spaces","description":"Use spaces for indentation"},
               {"label":"Tabs","description":"Use tabs for indentation"}],
    "multiSelect":false}]},
  "tool_use_id":"toolu_01HMT3…","requires_user_interaction":true}}
```

The answer is `allow` with an `answers` map keyed by the **full question text**,
alongside the echoed `questions` array (`e5_askanswer`, round-tripped — the model
then said "You said you prefer tabs"):

```json
{"behavior":"allow","updatedInput":{"questions":[…echoed…],
  "answers":{"Do you prefer tabs or spaces for indentation?":"Tabs"}}}
```

This is live confirmation of t3code's comment at `ClaudeAdapter.ts:3782-3789`,
which says the id **must** equal the question text because the SDK looks answers
up by text. t3code inferred it from a bug report; we have now seen the CLI do it.

**Cancellation.** DevDeck's existing interrupt payload — `{"type":
"control_request","request":{"subtype":"interrupt"}}` with **no** request_id
(`adapter.go:410-420`) — works. Sent while a permission was pending
(`e10_int_pending`) the CLI replied:

```json
{"type":"control_cancel_request","request_id":"db367905-…"}
{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}
```

then a `user-rejected` tool_result and `[Request interrupted by user]`. Two
consequences: the parser must retire a pending request on
`control_cancel_request`, and it must tolerate a `control_response` carrying no
`request_id` (because we sent none).

No CLI-side timeout on an unanswered request was observed within 57 s (`e4`).

### 1. Deliverable A1 — user input

No security consequence: the worst outcome of a bug is a wrong string reaching
the model, which the operator corrects with the next message.

#### 1.1 `buildArgs` gains the flag

`adapter.go:142-220` — append `--permission-prompt-tool stdio` unconditionally,
in every mode. Unconditional because the mode matrix shows the modes that never
prompt are unaffected by the flag's presence, and because `AskUserQuestion` must
be available in all of them.

The stale comment at `adapter.go:170-173` is rewritten in the same edit. Leaving
it is not acceptable: it is the reason the current behaviour was believed to be
"asks but can't answer" rather than "silently denies".

#### 1.2 The parser recognizes `control_request`

New `parse.go` arm for `"control_request"`, delegating to a new
`parseControlRequest`. Three outcomes:

| condition | emits |
|---|---|
| `tool_name == "AskUserQuestion"` | `event.UserInputRequested` |
| `tool_name == "ExitPlanMode"` | nothing (A1 auto-answers; see §2.0) |
| otherwise (`can_use_tool`) | nothing in A1 / `event.RequestOpened` in A2 |
| unknown `subtype` | `event.RuntimeWarning` carrying `Raw`, exactly as today |

That last row is not a fallback, it is the package's stated contract
(`parse.go:16-22`): a shape this file has never seen degrades to one warning,
never a crash and never a silent drop.

`RequestID` on the envelope is the **top-level** `request_id`.
`Refs.CallID` is `tool_use_id` (`event.go:120-131` — Refs is where native ids
live and they are never orchestration identity).

**Question normalization happens in Go, not in the client.** The parser emits
`UserInputRequestedPayload.Questions` as a normalized array:

```
{ id, header, question, options: [{label, description}], multiSelect }
```

with `id` = the full question text, falling back to `q-<idx>` when the CLI sends
a non-string or empty question — the exact rule at `ClaudeAdapter.ts:3789`.
It is done here rather than in the reducer for the reason the `event` package
opens with: no provider-specific rule may leak upward. "The key is the question
text" is a Claude-CLI fact. Every future provider hands the panel the same
shape, and the panel never learns why the id looks like a sentence.

#### 1.3 Ingestion forwards the payload

`workers.go:113-127`. Today's case flushes and dispatches one command. It
becomes flush → **activity-append** → session-set, three steps, in that order:

```go
case event.RequestOpened, event.UserInputRequested:
    if err := in.flushThread(ctx, ev.ThreadID); err != nil { return err }
    if err := in.dispatch(ctx, Command{
        Type: CmdThreadActivityAppend, ThreadID: ev.ThreadID,
        Payload: mustJSON(ev),          // the whole canonical envelope
    }); err != nil { return err }
    return in.dispatch(ctx, Command{ Type: CmdThreadSessionSet, … })
```

Two ordering rules, both load-bearing:

- **flush stays first.** It is the interaction-boundary flush the HANDOFF calls
  crucial (§7): if the agent asks "may I delete this file?", the reasoning that
  led there must already be on screen. (It is currently dormant — see §6 — but
  the order must be right for when it is not.)
- **payload before status.** A client that renders the panel on
  `status === 'waiting'` would otherwise paint one frame of an empty panel. The
  two commands can arrive in different `events` frames.

`mustJSON(ev)` is deliberately the same shape the `default:` arm already
produces (`workers.go:178-186`), so `isForwardedProviderEvent`
(`eventReducer.ts:127-133`) recognizes it with no new discriminator.

#### 1.4 The command path

`command.go` gains a typed payload beside `ApprovalRespondPayload`:

```go
type UserInputRespondPayload struct {
    RequestID string         `json:"requestId"`
    Answers   map[string]any `json:"answers"`
}
```

`engine.go:151-168` swaps its anonymous `struct{RequestID string}` for it. The
"not pending" guard at `engine.go:165` is unchanged — that is the double-tap
rejection, it already works, and it is checked in the decider rather than the
broker on purpose so the refusal is recorded and explainable (HANDOFF §6).

`workers.go` gains the missing Reactor case, placed next to its sibling:

```go
case EvtThreadUserInputResponseRequested:
    var p UserInputRespondPayload
    if err := json.Unmarshal(e.Payload, &p); err != nil { return err }
    return r.Provider.RespondToUserInput(ctx, e.ThreadID, p.RequestID, p.Answers)
```

No `Broker.Resolve` here, unlike the approval case at `workers.go:492-496`.
There is nothing to unblock — see the correction in §3.

`provider.go` gains `Service.RespondToUserInput`, a copy of
`Service.RespondToRequest` (`provider.go:369-375`).

#### 1.5 The adapter answers

`adapter.go:434-436` becomes a real write:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>",
  "response":{"behavior":"allow","updatedInput":{"questions":[…original…],"answers":{…}}}}}
```

The **original `questions` array must be echoed**, which is why the adapter
keeps a per-session pending map (§4.2) even in A1: the raw `input` arrives
minutes before the answer does.

Then emit `event.UserInputResolved` so the panel clears, and retire the entry.

#### 1.6 The panel

New `frontend/src/features/agent-chat/pendingUserInput.ts` — a port of
`t3code/apps/web/src/pendingUserInput.ts`, verbatim in behaviour, with
`UserInputQuestion` defined locally instead of imported from
`@t3tools/contracts`. Eight pure functions, no React, no DOM:
`resolvePendingUserInputAnswer`, `setPendingUserInputCustomAnswer`,
`togglePendingUserInputOptionSelection`, `buildPendingUserInputAnswers`,
`countAnswered…`, `findFirstUnanswered…`, `derivePendingUserInputProgress`.
This is the whole `n/m` counter, the "custom answer beats selected options"
rule, and the multi-select set semantics.

New `ComposerPendingUserInputPanel.tsx`, ported from t3code's 227-line panel:
header + `n/m` chip, question text, option buttons with `kbd` hints 1-9, check
icon on the selected option, optimistic single-select, 200 ms auto-advance.
Advancing past the **last** question is what submits — that is t3code's
`onAdvanceActivePendingUserInput` (`ChatView.tsx:5385-5401`), not a separate
Submit button, and it is why `derivePendingUserInputProgress` returns both
`isLastQuestion` and `isComplete`.

`types.ts` gains `pendingUserInputs: PendingUserInput[]` on `AgentThreadView`;
`eventReducer.ts` gains cases for forwarded `user-input.requested` /
`user-input.resolved` (open by requestId, delete by requestId — the same shape as
t3code's `derivePendingUserInputs`, `session-logic.ts:492-538`, but folded
incrementally instead of re-derived from the whole activity list).

`useAgentChatSocket.ts` widens `AgentCommandType` with
`'thread.user-input.respond'` and exposes `respondToUserInput(requestId,
answers)`. Both commands are already on the server's allowlist
(`command.go:55-56`), so no backend authorization change is needed.

`ChatComposer.tsx:191` fills its slot. `AgentChatPane.tsx` threads
`view.pendingUserInputs` and the responder down as new props.

#### 1.7 Focus, and the digit shortcut

t3code's 1-9 handler is a `document` listener that bails when the event target
is an `input`, a `textarea`, or inside a live `[contenteditable]`
(`ComposerPendingUserInputPanel.tsx:119-146`). **In DevDeck that rule makes the
shortcut nearly unreachable**, because G's composer is a TipTap contenteditable
that holds focus.

The rule is ported verbatim anyway — it is correct, and weakening it would make
typing "1." at the start of a message select an option. What changes instead:
**the panel moves focus to its first option button when it opens.** That is
defensible on its own terms: the panel opening means the agent is blocked on the
operator, so the operator's next keystroke belongs to the panel. Clicking or
tabbing into the editor hands focus back, and from that moment the editor's text
is the active question's `customAnswer` — which `resolvePendingUserInputAnswer`
already prefers over any selected option, no extra logic.

The custom-answer bridge is in A1's scope, not deferred: without it the operator
cannot answer anything the agent did not think to offer.

### 2. Deliverable A2 — approval

#### 2.0 The coupling A1 cannot avoid

`AskUserQuestion` is not exposed to the model without
`--permission-prompt-tool stdio` (§0). So **A1 must pass the flag**, and passing
the flag turns approval-required from a mode where the CLI silently denies into
a mode where the CLI *asks* — and in A1 there is no panel to answer with. Left
alone, A1 would hang the first tool call of every approval-required thread.

So A1 ships an explicit auto-responder for every `can_use_tool` that is not
`AskUserQuestion`:

```json
{"behavior":"deny","message":"DevDeck cannot approve tool use yet. Ask the operator to switch the thread's mode, or proceed without this tool."}
```

Behaviourally this is what happens today (the tool does not run, the model is
told why) — but three things improve, and one changes:

- the model now receives **our** message instead of a generic refusal, so it can
  react sensibly instead of retrying;
- the denial becomes a real `event.ToolDenied` and appears in the transcript,
  where today it is invisible (`parse.go:200-203`);
- `ExitPlanMode` gets the same treatment with t3code's plan-captured message
  (§4.6), which is strictly better than today's "plan mode with no exit";
- the tool_result's `non_execution_kind` changes from `"user-rejected"` to
  `"permission-rule"` (`e1` vs `e3_deny`). Nothing in DevDeck reads it; noted so
  it is not mistaken for a regression when re-capturing fixtures.

A2 replaces the auto-responder's body with the broker lookup. It is ~15 lines
and one call site, not a throwaway subsystem.

#### 2.1 What A2 adds on top of A1

Same path, three new pieces: a pending map with the metadata a decision needs, a
real broker for cancellation, and the decision → `PermissionResult` mapping.

### 3. The broker — and a correction to HANDOFF §6

`gg/HANDOFF.md` §6 prescribes a mandatory five-step order, of which step 2 is
*"`broker.Await(ctx, …)` — the adapter goroutine blocks"*, and describes Claude
as the callback-style provider (`canUseTool`) that needs it.

**That is true of t3code and false of DevDeck.** t3code drives Claude through
the TypeScript SDK, where `canUseTool` is a callback whose return value *is* the
answer, so something must block inside it. DevDeck drives the raw CLI over
`--input-format stream-json` (`adapter.go:142-147`): the request arrives on
stdout in `readLoop` and the answer leaves on stdin from the Reactor's
goroutine, minutes later. **There is no goroutine to block.** Over this
transport Claude is RPC-style, exactly like the Codex/ACP column the HANDOFF
contrasts it with.

Consequences, and they are the whole design of this piece:

- **`Await` is not added.** The `Broker` interface (`broker.go:22-31`) declares
  only `Resolve` and `CancelThread` today, and it stays that way. Adding a
  blocking primitive with no caller is dead code that reviewers would then have
  to reason about.
- **The provider-specific metadata does not live in the broker.** `tool_use_id`,
  the raw `input`, and `permission_suggestions` are Claude-CLI facts. They live
  in the claude `session` (§4.2), where the `event` package's rule keeps them —
  "no provider-specific type may leak into orchestration or the client"
  (`event.go:1-9`).
- **What the broker is left with is the job orchestration actually needs**: know
  which requestIds are open on which thread, and fan a thread-wide cancellation
  out to whoever must write the wire reply.

`approval.MemoryBroker`:

```go
type MemoryBroker struct {
    mu       sync.Mutex
    byThread map[string]map[string]struct{}   // threadID -> requestIDs
    OnCancel func(threadID, requestID string) // set by main.go -> provider.Service
}
func (b *MemoryBroker) Open(threadID, requestID string)
func (b *MemoryBroker) Resolve(requestID string, d event.Decision) error
func (b *MemoryBroker) CancelThread(threadID string)
```

`Resolve` returns `ErrUnknownRequest` for an id it does not hold — which the
Reactor already treats as benign (`workers.go:492-494`). `NoopBroker` stays for
tests.

**The four HANDOFF traps, mapped onto this transport:**

| Trap | How it is handled |
|---|---|
| *Abort must cancel approvals* | `Reactor` already calls `CancelThread` **before** `InterruptTurn` (`workers.go:498-507`), with the right comment. `CancelThread` now writes a `deny` per open request. The CLI also sends `control_cancel_request` itself (`e10`) — both paths are idempotent because the pending entry is deleted under the mutex by whichever arrives first. |
| *Session death must clean up* | `Ingestion` already calls `CancelThread` on `SessionExited` (`workers.go:170-177`). Here the process is gone, so `OnCancel`'s write fails and is discarded; the point is the `RequestResolved{cancel}` event that clears the UI. |
| *Double-tap from two devices* | Already works — `engine.go:146` and `:165`. A2 adds nothing. The projector clearing `PendingRequests` (`engine.go:262-284`) is what makes the guard fire; that is already in place for both commands. |
| *Two provider styles need two paths* | Already works — `workers.go:487-496` calls both `Broker.Resolve` and `Provider.RespondToRequest`. For claude the first is a no-op returning `ErrUnknownRequest` after A2 removes the entry, and the second does the work. The **user-input** case added in §1.4 deliberately calls only `RespondToUserInput`: user input is never callback-style on any provider we ship. |

There is a fifth trap the HANDOFF does not name, because a restart is outside a
single process's view: **a request pending across a server restart.**
`ReconcileOrphanedThreads` (`workers.go:290-310`) already handles it, clearing
`PendingRequests` in bulk on boot. Nothing to add; named so it is not
re-invented.

### 4. Adapter details (A2)

#### 4.1 stdin needs a mutex

`session` (`adapter.go:31-42`) holds a bare `*json.Encoder` and no lock. Today
that is survivable: `SendTurn` (`adapter.go:373`) and `InterruptTurn`
(`adapter.go:410`) are both driven from the Reactor's single goroutine. A2 adds
a second writer — `Broker.CancelThread` is called from **Ingestion's** goroutine
on `SessionExited` (`workers.go:170`), and its `OnCancel` writes a deny.

Two goroutines interleaving on one `json.Encoder` produce a corrupt NDJSON line,
which the CLI cannot parse and which takes the session down. Add
`stdinMu sync.Mutex` to `session` and take it in every writer. Three lines; the
alternative is an intermittent session death that looks like a CLI bug.

#### 4.2 The per-session pending map

```go
type pendingRequest struct {
    requestID   string
    toolUseID   string
    toolName    string
    input       json.RawMessage   // echoed back as updatedInput
    suggestions json.RawMessage   // echoed back as updatedPermissions
}
```

Held on `session`, keyed by requestID, deleted on answer or on
`control_cancel_request`. A1 needs `input` alone (to echo `questions`); A2 needs
all of it.

#### 4.3 Decision → `PermissionResult`

| `event.Decision` | wire |
|---|---|
| `accept` | `{"behavior":"allow","updatedInput":<input>}` |
| `acceptForSession` | as above **plus** `"updatedPermissions":<suggestions>` |
| `decline` | `{"behavior":"deny","message":"User declined tool execution."}` |
| `cancel` | `{"behavior":"deny","message":"User cancelled tool execution."}` |

Identical to t3code (`ClaudeAdapter.ts:4033-4051`), and each row is a verified
capture (`e2`, `e14`, `e3`).

**`RequestOpenedPayload.Options` is filled from what the CLI actually offered.**
`accept`, `decline`, `cancel` always; `acceptForSession` **only when
`permission_suggestions` is non-empty**. That field exists for exactly this
("support varies per provider", `event.go:236-240`), and without the guard
"Always allow this session" would silently degrade to "allow once" — the worst
kind of permission bug, because the operator believes they answered a question
they did not.

#### 4.4 Request classification

`tool_name` → `event.RequestType` (`event.go:102-107`):

| tool | RequestType |
|---|---|
| `Bash` | `command_execution_approval` |
| `Write`, `Edit`, `NotebookEdit` | `file_change_approval` |
| `Read` | `file_read_approval` |
| anything else | `unknown` |

`Detail` is a one-line human summary (`description` when the CLI sends one,
else a per-tool summary — t3code's `summarizeToolRequest`). `Args` is the raw
`input` JSON, unmodified, so the panel can show the full command or diff. When
`blocked_path` is present it is folded into `Detail` — it is the most specific
thing the CLI says about *why* it asked.

#### 4.5 Cancellation on the wire

`parse.go` handles `"control_cancel_request"`: retire the pending entry, emit
`RequestResolved{Decision: cancel}`. And `"control_response"` inbound from the
CLI (the interrupt ack, `e10`) is recognized-and-ignored — it must go in
`parseLine`'s deliberate-noise arm alongside `"assistant"`/`"user"`
(`parse.go:175-182`), **not** the warning arm, and it must not assume a
`request_id` is present.

#### 4.6 `ExitPlanMode`

Arrives as a `can_use_tool` with `requires_user_interaction:true` and no
suggestions (`m_stdio_plan`). Answering `allow` is read as plan approval — the
CLI injects *"User has approved your plan. You can now start coding…"* and
leaves plan mode.

Both A1 and A2 answer **`deny`** with t3code's message
(`ClaudeAdapter.ts:3934-3939`): *"The client captured your proposed plan. Stop
here and wait for the user's feedback…"*. Allowing it would drop the operator
out of the mode they explicitly selected, with no UI having asked them. B owns
the approve path and the card; A owns not breaking plan mode.

Note for whoever writes B: the CLI writes the plan to `~/.claude/plans/…md` and
puts the path in `input.planFilePath` **before** asking (`m_stdio_plan`), so the
plan text is available whether or not it is approved.

### 5. Discrimination rules, stated once

Getting these wrong is how `AskUserQuestion` ends up in the approval panel.

- `requires_user_interaction === true` alone is **not** the user-input
  discriminator — `ExitPlanMode` sets it too.
- Branch on `tool_name` first (`AskUserQuestion` / `ExitPlanMode` / everything
  else), and treat `requires_user_interaction` as corroboration only.
- Absence of `permission_suggestions` is corroboration, never the test: a
  `can_use_tool` for an ordinary tool may legitimately arrive without
  suggestions, and that case must still open an approval panel — with
  `acceptForSession` withheld (§4.3).

### 6. Dormant, and why

- **`Broker.Await`** — not added; §3 explains why the HANDOFF's step 2 does not
  apply to this transport.
- **Buffered delivery.** `NewIngestion` sets `Buffered: false`
  (`workers.go:73`) and nothing anywhere overrides it, so the
  interaction-boundary flush at `workers.go:113-118` is a correct no-op today.
  A does **not** turn it on — that is a mobile-delivery decision with its own
  cost/benefit. A only guarantees it stays correct by keeping the flush first
  (§1.3).
- **`set_permission_mode` / `set_model`.** Documented in the CLI's embedded
  schema (`capture/strings.txt`). They would let the runtime-mode and model
  pills act on a *live* session instead of only the next one, which is a real
  improvement and entirely out of scope here.
- **`request_user_dialog`** — requires declaring a capability in an `initialize`
  handshake DevDeck does not send.
- **`pending_permission_requests` on the `initialize` response** — the CLI's own
  answer to "a client reconnected while a prompt was open". DevDeck solves the
  same problem from its event log (`ReconcileOrphanedThreads`), so this is
  redundant today; it becomes interesting only if DevDeck ever reattaches to a
  CLI it did not spawn.
- **`interrupt_receipt_v1`** — a capability that would make the interrupt
  acknowledged rather than best-effort. `workers.go:508-524` currently settles
  the thread unconditionally *because* it is best-effort; that comment is the
  place to revisit if this is ever adopted.

## Data flow

```
claude CLI stdout (NDJSON)
  │  {"type":"control_request","request_id":R,"request":{subtype:can_use_tool,…}}
  ▼
parse.go  parseControlRequest ──── AskUserQuestion ──▶ event.UserInputRequested
  │                          └──── other tool ───────▶ event.RequestOpened   (A2)
  │                                                    (A1: auto-deny straight back to stdin)
  ▼
Ingestion.handle                     workers.go:113
  │ 1. flushThread                   (buffered delta boundary — dormant)
  │ 2. CmdThreadActivityAppend       ← the payload the UI renders   [NEW]
  │ 3. CmdThreadSessionSet           {status:waiting, pendingRequestAdd:R}
  ▼
Engine.Decide / Apply ──▶ persisted events ──▶ /ws/agent ──▶ reduceAgentEvents
                                                                │
                                    view.pendingUserInputs[] ───┤  [NEW]
                                    view.pendingApprovals[]  ───┘  [NEW, A2]
                                                                │
                                                                ▼
                                          ChatComposer  data-slot="composer-panels"
                                            ├─ ComposerPendingUserInputPanel  (A1)
                                            └─ ComposerPendingApprovalPanel   (A2)
                                                                │
                       operator answers (click / digit 1-9 / composer text)
                                                                ▼
   {thread.user-input.respond | thread.approval.respond}  ──▶ WS ──▶ Engine.Decide
                                                    (double-tap guard: engine.go:146,165)
                                                                ▼
                                                        Reactor.react
              user-input ──▶ Service.RespondToUserInput ──┐   [NEW case + NEW method]
              approval   ──▶ Broker.Resolve               │
                          + Service.RespondToRequest ─────┤   (workers.go:492-496, exists)
                                                          ▼
                                          claude adapter, stdinMu held
   {"type":"control_response","response":{"subtype":"success","request_id":R,
     "response":{"behavior":"allow","updatedInput":{…},"updatedPermissions":[…]}}}
                                                          │
                                                          ▼
                                                 claude CLI stdin
```

## Testing

TDD, and the pure layers first — as with G, most of this is pure.

**Go — parser (table tests over checked-in fixtures).** New
`testdata/control_request_*.ndjson`, captured lines copied verbatim from
`capture/e2_ppt_stdio`, `e4_askuser`, `e15_bash`, `e7_accept_webfetch`,
`m_stdio_plan`, `e10_int_pending`. Cases:
- `AskUserQuestion` → `UserInputRequested`, `RequestID` == the **top-level**
  `request_id` (a test that would fail if someone reads `request.request_id`),
  `Refs.CallID` == `tool_use_id`
- question `id` == full question text; empty/non-string question → `q-<idx>`
- `ExitPlanMode` → not a user-input event (the `requires_user_interaction` trap)
- `Bash` with `blocked_path` and three suggestion kinds → `RequestOpened` with
  `requestType` `command_execution_approval`
- `permission_suggestions` empty → `Options` **excludes** `acceptForSession`
- `control_cancel_request` → `RequestResolved{cancel}`
- `control_response` inbound with no `request_id` → no event, **no warning**
- unknown `subtype` → exactly one `RuntimeWarning` carrying `Raw`

**Go — decision mapping.** Pure table: each `event.Decision` → expected JSON
bytes, byte-compared against the four verified captures.

**Go — orchestration.**
- Reactor: `EvtThreadUserInputResponseRequested` reaches
  `Service.RespondToUserInput` with the answers intact. This test fails on
  `main` today — it is the regression test for the silent no-op.
- Broker: open two requests on a thread, `CancelThread`, assert both `OnCancel`
  calls fire and a later `Resolve` returns `ErrUnknownRequest`.
- Ingestion: `RequestOpened` produces **two** commands in the order
  activity-append → session-set (extend `workers_test.go`).
- Existing `TestApprovalDoubleTap…` must stay green untouched.

**Frontend — pure (no DOM).** Port t3code's `pendingUserInput` tests; the
interesting rows are custom-answer-beats-selection, multiSelect toggle
idempotence, `buildPendingUserInputAnswers` returning `null` while any question
is unanswered, and `findFirstUnanswered…` clamping on a fully answered set.

**Frontend — reducer.** `user-input.requested` opens; `user-input.resolved`
closes; a replayed tail re-delivering both is idempotent; two open requests
preserve arrival order.

**Frontend — component.**
- digit `3` selects the third option when the panel holds focus
- digit `3` does **nothing** when focus is inside the editor (the ported guard)
- single-select auto-advances after 200 ms; multi-select does not
- advancing past the last question dispatches `thread.user-input.respond` with
  answers keyed by question text
- A2: an approval whose `options` omit `acceptForSession` renders no
  "Always allow this session" button

**Regression — must stay green, unmodified:** `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `ComposerPromptEditor.test.tsx`,
`AgentChatPane.test.tsx`, `MessagesTimeline.test.tsx`, `eventReducer.test.ts`,
`adapter.test.ts`, `timeline.test.ts`, `composerSerialize.test.ts`,
`workers_test.go`, `workers_reactor_test.go`, `driver_test.go`.

`npm test` shows one pre-existing failure in the monaco guard test. It is not a
regression from this work and must not be "fixed" as part of it.

**Not covered by any test, and it must be a manual gate before A1 merges:** the
live CLI. See the first risk.

## Risks

**The protocol is a moving target, and the fixtures are a snapshot.**
Everything here was captured against **2.1.233**. `parse.go`'s package comment
already states the rule (the fixture in `testdata/turn.ndjson` was captured at
2.1.224 and the comment says to re-run and re-map when it is recaptured, never
to guess). The new fixtures inherit that rule. Note the version drift is already
real: the parser's existing fixture is nine patch releases behind the captures
in this spec.

**The flag changes the default behaviour of every existing thread.** Today
approval-required silently denies; after A1 it prompts and A1's auto-responder
denies with a message. After A2 it prompts and *waits for a human*. A thread
left open in a background tab now blocks on a click. That is the intended
feature, but it is a behaviour change to a mode threads are created in by
default (`engine.go:236-238` — `ModeApprovalRequired` is the fallback), and it
should land with F's banner or an obvious panel, not silently.

**`--permission-prompt-tool stdio` was never tested together with
`--mcp-config`.** The `e13_bogus_ppt` failure mode proves the value is matched
against MCP tool names, so a real MCP server *should* be irrelevant — but that
is reasoning, not evidence. **Mitigating fact, verified:** DevDeck never passes
`--mcp-config` today. `SessionStartInput.MCPEndpoint` is read at
`adapter.go:204-217` and set by **nobody** — `grep -rn MCPEndpoint backend`
returns only the type definition, that read, and a comment in the pi adapter. So
the untested combination is currently unreachable. It becomes reachable the day
someone wires the MCP endpoint, and that change must re-run the capture.

**`multiSelect` answer shape is unverified.** `e5_askanswer` round-tripped a
single-select answer as a bare string. t3code sends `string[]` for multiSelect
(`pendingUserInput.ts`'s `Record<string, string | string[]>`) and the Go side
will do the same, but no capture forced a multiSelect question. Cheap to close:
one `drive.py` run with a prompt that asks for multiple picks. Do it before A1
merges.

**Two simultaneously pending requests were never captured.** Both panels render
the head with an `n/m` counter, and the engine's `PendingRequests` is a set, so
the model tolerates it — but the CLI's own behaviour with two open prompts (does
it queue, does it cancel the first?) is unknown. The `still_queued` field on the
interrupt ack (`e10`) hints there is a queue.

**Unanswered-request behaviour past ~57 s is unknown.** No CLI-side timeout was
observed within that window (`e4_askuser`). If one exists, a slow operator gets
a request the CLI has already abandoned. `control_cancel_request` handling
(§4.5) is the defence, and it is the reason that case is in A2 rather than
deferred.

**Digit shortcut vs. editor focus.** Covered by §1.7 and by two component tests
that pin both directions. The failure this guards against is a `kbd` hint that
promises a key which does nothing.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
neither deliverable can be committed file-by-file. A1 lands as one commit, A2 as
another.

## Files

### A1

**New (backend):** none — every file already exists.

**Modified (backend):**
- `provider/claude/adapter.go` — `buildArgs` gains
  `--permission-prompt-tool stdio` and loses the stale comment
  (`:170-173`); `RespondToUserInput` (`:434-436`) becomes real;
  `session` gains `stdinMu` and `pending`
- `provider/claude/parse.go` — `control_request` / `control_cancel_request` /
  `control_response` arms; `parseControlRequest`; question normalization
- `provider/provider.go` — `Service.RespondToUserInput`
- `orchestration/workers.go` — Ingestion forwards the payload (`:113-127`);
  Reactor gains `EvtThreadUserInputResponseRequested`
- `orchestration/command.go` — `UserInputRespondPayload`
- `orchestration/engine.go` — decider uses the typed payload (guard unchanged)

**New (frontend):** `pendingUserInput.ts` (+ tests),
`ComposerPendingUserInputPanel.tsx` (+ tests).

**Modified (frontend):** `types.ts`, `eventReducer.ts`, `useAgentChatSocket.ts`,
`ChatComposer.tsx` (fills `data-slot="composer-panels"`), `AgentChatPane.tsx`
(threads the new props).

**New (test data):** `provider/claude/testdata/control_request_*.ndjson`.

### A2

**New (backend):** `approval/memory_broker.go` (+ tests).

**Modified (backend):** `provider/claude/parse.go` (the non-interactive
`can_use_tool` arm, `RequestOpened`, classification, `Options`),
`provider/claude/adapter.go` (`RespondToRequest`, the auto-responder's body
replaced by the broker lookup), `approval/broker.go` (`NoopBroker` stays;
`MemoryBroker` added alongside), `cmd/server/main.go` (`:445-446`, `:463-464` —
`NoopBroker{}` → `MemoryBroker`, and `OnCancel` wired to `provider.Service`).

**New (frontend):** `ComposerPendingApprovalPanel.tsx`,
`ComposerPendingApprovalActions.tsx` (+ tests).

**Modified (frontend):** `types.ts`, `eventReducer.ts`, `useAgentChatSocket.ts`,
`ChatComposer.tsx`, `AgentChatPane.tsx`.

**Untouched by both:** `store/types.ts`, `domain/models.go`, `port/store.go`,
`routeTree.gen.ts`, `MessagesTimeline.tsx`, `ComposerPromptEditor.tsx`,
`ComposerControls.tsx`, the vendored `components/ai-elements/*`.

`cmd/server/main.go` is on CLAUDE.md's serialize-never-parallelize list. It is
touched by A2 only, in one hunk, and must not be edited from a parallel agent.
