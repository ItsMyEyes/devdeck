# Agent Chat — t3code Parity & Session History

> Spec 1b. Follows `2026-08-07-agent-chat-pane-design.md`, which shipped a
> working harness behind a chat surface that does not match its reference.
> This spec brings the surface to parity with
> [t3code](https://github.com/pingdotgg/t3code) and adds session history.

## Problem

Spec 1's chat pane works structurally but looks nothing like its reference.
Three concrete defects:

**The header wraps into a wall of dropdowns.** `ChatHeader` renders four
`Select`s at `min-w-[120px]`–`min-w-[150px]` inside a `flex-wrap` row. The pane
is never wide enough, so they stack into four full-width rows — roughly 430px
of chrome above an empty transcript.

**The controls are in the wrong place entirely.** t3code's `ChatHeader` carries
*no* model or mode pickers. They live in the composer footer as compact ghost
pills. This is a structural difference, not a styling one; restyling the
selects in place would still be wrong.

**The controls do nothing.** `modelId`, `runtimeMode`, and `interactionMode` are
local `useState` that are never dispatched. They render correctly and silently
lie about what the agent is doing.

Separately, there is no way to see prior conversations in a worktree.

## Decisions

1. **The chat surface matches t3code's layout exactly**, restyled with
   DevDeck's v2 tokens. No t3code colour values cross over.
2. **Session history is a third sidebar tab**, beside Explorer and Git, backed
   by real data — not an empty shell.
3. **The mode and model controls dispatch real commands.** A control that
   cannot affect the agent is worse than no control.
4. **Tool rows collapse to one visible entry**, matching t3code's
   `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`.
5. **The changed-files card is out of scope** — see Non-goals.

## Absorbed prerequisites

This spec cannot be built on spec 1 as shipped. Two of the three critical
findings from spec 1's review are prerequisites here, so they are in scope:

| Finding | Why this spec needs it |
|---|---|
| No thread provisioning — nothing dispatches `thread.create`, calls `Registry.StartInstance`, `ThreadDirectory.Bind`, or `Adapter.StartSession` | Session history has nothing to list until threads are actually created, and no turn can run at all |
| `Decide` has no case for `CmdThreadInteractionModeSet`, `CmdThreadUserInputRespond`, `CmdThreadActivityAppend`, `CmdThreadAssistantComplete`, `CmdThreadTurnDiffComplete` — all fall to `unrecognized command` | Wiring the mode controls dispatches two of these; tool rows need `ActivityAppend`, which Ingestion's fallback uses for every `ItemStarted`/`ItemCompleted` |

The third finding (the `/ws/agent` snapshot-before-subscribe race) is
independent and also fixed here, because it is two lines and this spec touches
that handler anyway.

## Layout

```
┌─ Chat ─────────────────────────────────── ● Idle ──┐   header: title + status only
│                                                    │
│  You  fix the auth redirect                        │
│                                                    │
│  ▸ 3 earlier steps                                 │   collapsed work log
│  ⚙ Read  src/auth.ts                               │   newest tool row only
│                                                    │
│  I found the bug in the callback…                  │
│  2:40:02 PM • 10s                                  │   turn stamp
│                                                    │
├────────────────────────────────────────────────────┤
│  Ask for follow-up changes or attach images        │
│                                                    │
│  ✳ Sonnet 5 ⌄ │ High · Normal ⌄ │ ▣ Build │        │   one row, dividers
│                 🔒 Full access ⌄          ⟨85⟩ ⬆   │   meter + circular send
└────────────────────────────────────────────────────┘
  🗀 worktree                              main ⌄        status strip
```

### Header

Title, an optional thread-suffix chip, and the status dot. Nothing else. The
four `Select`s are removed, not restyled.

### Composer

The textarea and the control row live inside **one** bordered box. Below it, a
status strip carries the worktree on the left and the branch on the right.

Controls are ghost pills on a single line, separated by thin vertical rules,
mirroring t3code's `ComposerControl`:

```
h-7 min-h-7 gap-1.5 px-2.5, ghost variant,
muted foreground → foreground on hover, size-3.5 chevron
```

| Control | Content | Dispatches |
|---|---|---|
| Model | provider icon + model name | `thread.turn.start` payload |
| Effort | `High · Normal` — effort · thinking, **one** control | `thread.turn.start` payload |
| Interaction mode | icon + `Build` / `Plan` | `thread.interaction-mode.set` |
| Runtime mode | lock icon + `Full access` | `thread.runtime-mode.set` |

Overflow collapses into a `…` menu rather than wrapping — wrapping is the
original defect and must be structurally impossible, not merely unlikely.

Send is a **circular filled button with an up arrow**, not a labelled button.
A ring-style context meter sits beside it. While a turn runs, the send button
becomes the interrupt control.

### Tool rows

Tool calls render as work-log rows: icon, tool name, target. Only the newest is
visible; earlier ones collapse behind a `▸ N earlier steps` disclosure. t3code
chose this so a twenty-step turn does not push the prose off screen.

Reasoning stays a separate collapsed block, as in spec 1.

Each completed turn is stamped `2:40:02 PM • 10s`.

### Session history

A third `ShellSidebarPanel` value, `'sessions'`, beside `'explorer'` and
`'git'` (`useDevDeckStore.ts:211`). Rows show title, status dot with label,
and relative time; the active thread is highlighted; older entries fold behind
`Show more`.

Selecting a row opens that thread in a chat pane. Sessions are per-worktree.

## Data flow for sessions

`agent_thread` exists but nothing writes to it. This spec adds the write side:

- `CommitAgentEvents` inserts an `agent_thread` row when it commits an
  `EvtThreadCreated` event — a projection into a read table, inside the same
  transaction as the append, preserving spec 1's atomicity contract.
- `GET /api/agent/threads?worktree=<id>` returns the list, through
  `port.Store`, using `handleStoreErr` and the `{"error":"message"}` envelope.
- The frontend reads it through `machineClient`, since threads live on the
  runtime that owns the worktree.

`agent_thread` gains `title`, `agent_id`, `model`, and `updated_at` so a row can
render without replaying its whole event log.

## Provisioning

Threads are created lazily and idempotently:

- On `hello`, if `AgentEventsSince` returns nothing for the thread, the WS
  handler dispatches `thread.create` with a `CommandID` derived from the thread
  id (`ac-create-<threadKey>`), so a reconnect resends an identical command and
  is absorbed by `SeenCommand` rather than erroring.
- `EvtThreadCreated` joins `IntentEvents`. Its `Reactor` case calls
  `Registry.StartInstance` (idempotent, keyed by `InstanceID`), then
  `Dir.Bind`, then `Adapter.StartSession`.
- `Reactor`'s `EvtThreadSessionStopRequested` case is changed to route through
  `Provider`/`ThreadDirectory` like every other case, instead of reaching into
  `Registry` with an `InstanceID` from engine state. Two never-reconciled
  lookup paths in one switch is a latent divergence.

The agent for a thread comes from the worktree's `Worktree.Agent`, mapped to
`InstanceID` `<agent>:default`.

## Non-goals

**The changed-files card** (`CHANGED FILES (7) · +31/−17`, file tree, per-file
`+4/−0`, Collapse all / View diff) is deliberately excluded. It renders
turn-diff data, and no adapter emits `TurnDiffUpdated` yet. Building its chrome
now would ship a card that never populates — the same "reads as working, does
nothing" defect this spec exists to remove. It belongs with spec 4's diff
plumbing.

Also unchanged: approval UI (spec 2), the four non-Claude adapters (spec 3),
checkpointing and cross-restart resume (spec 5).

## Error handling

| Failure | Behaviour |
|---|---|
| Selected agent not installed on the runtime | Pill shows it disabled with `Probe`'s `Detail` as the reason |
| Mode command rejected by the decider | Pill reverts to the thread's actual mode; error surfaces in the transcript, never silently |
| `StartInstance` or `StartSession` fails | `EvtThreadCreated` is already committed; the failure appends a visible error entry and the thread stays readable |
| Session list request fails | Sidebar renders its error state with a retry, per frontend rules |
| Thread has no events yet | Sessions row still appears — `agent_thread` is written on creation, not on first message |

## Testing

- **Decider** — a table test dispatching **every** `CommandType` in the const
  block, asserting a specific event or an explicit documented rejection. The
  generic `unrecognized command` fallthrough is what hid finding #2; this test
  makes adding a command without a rule impossible to miss.
- **Provisioning, end to end** — the test spec 1 lacked: a thread with no prior
  events, through `/ws/agent`, reaching a fake adapter's `SendTurn`. This must
  cross the WS → engine → reactor → directory → adapter seam in one test,
  because every critical finding lived in that seam.
- **Replay race** — a commit landing between snapshot and subscribe must still
  reach the client.
- **Sessions** — `EvtThreadCreated` writes an `agent_thread` row in the same
  transaction; a rolled-back commit leaves none.
- **Composer controls** — a mode pill dispatches its command; overflow collapses
  to a menu instead of wrapping at narrow widths.
- **Tool rows** — with N tool entries, exactly one is visible and the
  disclosure reports `N-1`.

Verification: `go vet ./... && go test ./... -race`, `npm run typecheck`,
`npx vitest run`.

> New frontend test files must be added to the `test.include` list in
> `frontend/vite.config.ts` — this project enumerates test files explicitly
> rather than globbing, so an unregistered test file silently never runs.

## Risks

**This spec changes `Decide`, which is the purest and most load-bearing code in
the system.** Adding five cases risks weakening the invariant that makes the
whole rule set table-testable. Every new case must stay pure — no clock, no
I/O, no randomness — and the replay-determinism test must pass unchanged.

**Provisioning introduces the first place a committed event triggers a
long-running side effect** (spawning a CLI process). The commit must not depend
on the spawn succeeding: the event is durable first, the process starts after,
and a failed spawn is a visible error rather than a lost thread.
