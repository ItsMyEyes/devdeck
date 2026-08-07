# Agent Chat Pane — Design

> Spec 1 of 5. Replaces the raw agent PTY with a structured chat surface backed
> by an event-sourced harness, adapted from `gg/agentcore` (which is itself
> derived from [pingdotgg/t3code](https://github.com/pingdotgg/t3code)).
> Read `gg/HANDOFF.md` before implementing — it is the source document for
> every architectural decision restated here.

## Problem

Opening a DevDeck worktree spawns the worktree's configured agent CLI
(`Worktree.Agent` ∈ `claude|codex|pi|opencode|gemini`) inside a raw PTY:
`terminal.Server.resolveCommand()` resolves the binary via `detect.Resolve()`
and `attachPTY` streams bytes both ways. The backend has no idea what the
agent is doing — it cannot render reasoning separately from the answer, show
tool calls as structured rows, surface an approval prompt, resume a turn
exactly after a dropped connection, or replace one provider with another
mid-thread.

We want a chat surface with that structure, across many runtime machines.

## Scope

**In scope (this spec):** the complete canonical event vocabulary; an
event-sourced orchestration engine; the Claude adapter; a `/ws/agent`
WebSocket on the runtime; a new `agent-chat` pane rendering streamed text,
reasoning, and read-only tool-call rows.

**Out of scope (later specs):**

| Spec | Contents |
|---|---|
| 2 | Approval flow — broker, four traps, `RuntimeMode` × `InteractionMode`, buffered delivery |
| 3 | Remaining adapters — codex, pi, opencode, gemini |
| 4 | Rich surfaces — plan cards, turn diff, changed-files tree, token meter |
| 5 | Checkpointing, resume across server restart, built-in MCP |

## Decisions

These were settled during brainstorming and are not open for
reinterpretation during implementation.

1. **Chat is a new pane kind; the terminal stays.** `paneTree.ts` gains an
   `agent-chat` pane. Opening a worktree defaults to it, but
   `createTerminalPane` is untouched and still one split away. Nothing
   existing is deleted.
2. **Chat UX is modelled on t3code's `apps/web/src/components/chat/`**
   (ChatHeader + MessagesTimeline + ChatComposer) but styled entirely with
   DevDeck's own tokens. None of t3code's palette crosses over.
3. **All five agents in `detect.AgentBinary` are targets**, with the
   available set driven by `Probe` on the runtime machine hosting the
   worktree. Only the Claude adapter is built in this spec; the Driver
   registry is built for all five from day one.
4. **Transport is a WebSocket to the runtime backend**, exactly like
   `/ws/terminal`, because DevDeck has many runtimes.
5. **Vertical slice.** The event vocabulary is defined completely up front;
   every other layer is built thin. A working chat is the deliverable.

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Browser — agent-chat pane                       │
│   send Command · subscribe Event · replay(Seq)  │
└──────────────────┬──────────────────────────────┘
                   │ machineWsUrl(machine, '/ws/agent', …)
                   │ direct-first, hub-proxy fallback
┌──────────────────▼──────────────────────────────┐
│ RUNTIME MACHINE (owns the worktree)             │
│                                                 │
│  handler/agent_ws.go   ── registry keyed by     │
│         │                 threadKey             │
│  ┌──────▼───────────────────────────────────┐   │
│  │ agentcore/orchestration                  │   │
│  │   Command → Decide → Event → Apply       │   │
│  └──┬──────────────────────────▲────────────┘   │
│     │ Reactor (out)            │ Ingestion (in) │
│  ┌──▼──────────────────────────┴────────────┐   │
│  │ agentcore/provider — Driver + Adapter    │   │
│  └──────────────────┬───────────────────────┘   │
│                     │ stdio NDJSON              │
│              claude --print --output-format …   │
│                                                 │
│  port.Store → SQLite (this runtime's own db)    │
└─────────────────────────────────────────────────┘
```

**Everything runs on the runtime.** The engine, the adapter, and the agent
process all live on the machine that owns the worktree. The hub never spawns
an agent; it only reverse-proxies the WebSocket when a direct connection is
unavailable. A runtime that loses its hub keeps chatting.

**Consequence, stated plainly:** the event log lives in the *runtime's*
SQLite, so a thread is readable only while that machine is reachable. This
was accepted deliberately — it is what keeps execution independent of hub
availability, and it matches where worktrees and PTYs already live.

### Package layout

`gg/agentcore` is copied into `backend/internal/agentcore/` as ordinary
internal packages. Its standalone `go.mod` is **dropped**; DevDeck remains a
single Go module.

```
backend/internal/agentcore/
  event/           canonical event vocabulary  (complete)
  provider/        Driver, Adapter, Registry, Service
  provider/claude/ the one adapter built in this spec
  approval/        Broker interface only — no implementation until spec 2
  orchestration/   decider, projector, engine, ingestion, reactor
```

### Persistence

The skeleton's own `Store` interface is deleted. Persistence goes through
`port.Store` per `CONTRACTS.md`, which gains four methods:

| Method | Contract |
|---|---|
| `CommitAgentEvents(commandID, events)` | Append + projection + receipt in **one** transaction |
| `AgentEventsSince(threadID, seq)` | Ordered replay for reattach |
| `SeenCommand(commandID)` | Idempotency check, called before `Decide` |
| `AgentThreads(worktreeID)` | Thread list for a worktree |

`orchestration` depends on a **narrow interface it declares itself**, which
`store.SQLStore` satisfies. That keeps decider tests free of SQLite without
bypassing `port.Store`.

> `backend/internal/port/store.go` is on the convergence-file list in
> `CLAUDE.md`. This edit must be a single serialized step, never parallel work.

New tables: `agent_thread`, `agent_event`, `agent_command_receipt`.

### Canonical events

All ~15 CORE types from `event/event.go` are defined up front — including
ones Claude never emits. This is the one place we build ahead of need,
because HANDOFF's central warning is that an event vocabulary born from a
single provider stays bent around it forever, and spec 3 adds four providers.

Four invariants carry into storage:

- **Envelope separate from payload.** Every event carries `EventID`,
  `ThreadID`, `TurnID`, `ItemID`, `RequestID`, `CreatedAt`; payloads differ
  by type and decode through a registry.
- **`Refs` holds native IDs.** Claude's session UUID lives only in `Refs`
  and is read only by the adapter. Orchestration uses DevDeck's own IDs.
  Without this, resume and provider-swap are impossible.
- **`Raw` is for debugging only.** The native message is stored. No
  production code path may branch on it.
- **`Sequence` is monotonic per `(ItemID, StreamKind)`.** The client uses it
  to detect dropped or reordered deltas. `StreamKind` keeps `text` and
  `reasoning` in separate streams so they can render separately — merging
  them now would mean a data migration later.

### Driver vs Adapter

A **Driver** is a declarative value that lives forever and knows about
config, binary, and version. An **Adapter** is a live process that knows
about sessions, turns, and streams. They are separate so the settings screen
can display "claude v2.1.219, authenticated" **without spawning an agent**.

`Probe` returns `(Snapshot, error)` where **a missing binary is not an
error** — it is a normal status that must reach the UI. This maps directly
onto the existing `detect.Installed` / `detect.ProbeAll`.

**`InstanceID`, never `Kind`.** Every event, command, and route key carries
`InstanceID` from the first commit, even though this spec creates exactly one
instance per agent (`claude:default`). t3code routed on `Kind` first and paid
for the migration; their migration comments are still in the source.
`Config.HomeDir` exists so two instances with different accounts cannot
overwrite each other's credentials.

**Probe is per-machine.** The chat header's agent picker must show what is
installed on *that worktree's runtime*, not on the hub.
`service.AgentService.ListAgents()` gains a probe snapshot (installed,
version, authenticated) and the frontend reads it through `machineClient`
like every other runtime call.

### Engine

Four things from HANDOFF §5 that are not negotiable:

- **Commands are imperative, events are past tense.** `thread.turn.start`
  (intent) vs `thread.turn-start-requested` (fact). Mixing them makes the
  log unreadable.
- **`Decide(state, cmd, now, newID)` is pure.** No I/O, no `time.Now()`, no
  randomness — hence `now` and `newID` as parameters. This is what lets the
  whole business layer be table-tested with zero mocks.
- **One goroutine processes all commands.** The decider is pure and fast;
  slow provider calls happen in the Reactor, outside the loop. Total
  serialisation is what lets the decider treat state as stable.
- **Commit, then swap, then publish — in that order.** Swapping first means
  a failed commit leaves the in-memory read model holding facts that were
  never logged, with no way to detect it.

`Ingestion` (provider → engine) and `Reactor` (engine → provider) stay
separate components. Merging them deadlocks: the engine waits on a provider
that is waiting on the engine.

## Transport: `/ws/agent`

Registered on the runtime beside `/ws/terminal`, reached through
`machineWsUrl(machine, '/ws/agent', params)` — inheriting direct-first
routing, hub-proxy fallback, and `?key=` auth unchanged.

It diverges from `/ws/terminal` in one important way. The terminal streams
raw bytes and reattaches from a lossy ring buffer. Chat is a JSON envelope
protocol: the client sends `Command`s, the server sends `Event`s, and on
connect the client sends the last `Seq` it saw so the server can replay from
`AgentEventsSince`. Reattach is therefore **exact, not best-effort** — a
phone that slept through an entire turn catches up perfectly. This is the
concrete payoff for event-sourcing.

**Session lifetime copies the PTY contract: closing the pane or the tab does
not kill the turn.** A registry keyed by thread id holds the live adapter;
the engine keeps consuming, events keep landing in SQLite, and reopening
replays. This matches how worktree terminals already survive tab close, and
agent turns routinely run for minutes.

`CommandID` provides idempotency: a client that reconnects and resends gets
the same events back rather than starting a second turn. DevDeck's WebSocket
clients already reconnect aggressively on mobile, so this path is exercised
constantly, not rarely.

**Known gap, accepted for this spec:** every delta is forwarded as its own
frame. Behind a production tunnel that is chatty. `permessage-deflate` is
negotiated as it is for the terminal, but the real fix — `DeliveryPolicy`
with flush on `MaxChars` or on an interaction boundary — lands in spec 2,
because the flush-on-approval trigger is only meaningful once approvals
exist.

## Frontend

`PaneContentKind` gains `'agent-chat'`; the `PaneContent` union gains
`{ kind: 'agent-chat'; id; threadKey; label }` — deliberately the same shape
as the terminal pane's `sessionKey`, so `createAgentChatPane` is a sibling of
`createTerminalPane` and all existing split / drag / serialize machinery in
`paneTree.ts` works untouched.

`threadKey` **is** the backend's `ThreadID`, verbatim — one name per side of
the wire, no mapping table. A worktree's primary chat thread uses the bare
worktree id; additional chat panes split from it use `<worktreeId>::chat-N`,
mirroring how extra terminal panes use `<worktreeId>::term-N`.

```
frontend/src/features/agent-chat/
  AgentChatPane.tsx      pane shell, WS lifecycle
  ChatHeader.tsx         agent · model · mode pickers (per-machine probe)
  MessagesTimeline.tsx   messages, reasoning blocks, tool rows
  ChatComposer.tsx       input + send + abort
  eventReducer.ts        Event[] → view model          (pure, tested)
  timeline.ts            grouping / ordering           (pure, tested)
  scrollAnchoring.ts     follow-mode re-arm            (pure, tested)
```

Pure logic is split into its own files and unit-tested, matching both
t3code's `.logic.ts` convention and DevDeck's existing `paneTree.ts` /
`paneTree.test.ts` pattern.

Streamed events fold into a view model through a reducer in a **zustand**
slice keyed by `threadKey`, alongside `browserTiles` and `sshTileLayouts` —
**not** react-query, which is not built for a stream.

Rendering rules: reasoning renders as a separate, collapsed-by-default block
from the answer (this is what `StreamKind` bought). Tool calls render as
read-only rows; their Allow/Deny buttons arrive in spec 2. Loading, error,
and empty states are explicit, per `.claude/rules/frontend.md`.

Scroll follow uses a small **re-arm band** above the bottom rather than a 1px
"is at end" check. t3code's comment records why: the naive version re-arms
while the user is reading history and yanks them back down on the next
chunk.

Styling: DevDeck v2 tokens from `globals.css`, `@base-ui/react`,
`lucide-react`, dark-only, `cn()` for class merging, `@/*` imports,
`import type` for type-only imports.

## Error handling

| Failure | Behaviour |
|---|---|
| Agent binary not installed | `Probe` reports it as status, not error; picker shows it disabled with a reason |
| Agent process exits mid-turn | `SessionExited` event; timeline shows a terminal banner; thread stays readable |
| Adapter cannot parse a native message | `RuntimeWarning` event carrying `Raw`; stream continues. Never a silent drop |
| `CommitAgentEvents` fails | Engine returns the error, state is **not** swapped, nothing is published |
| WebSocket drops | Engine keeps running; client reconnects and replays from last `Seq` |
| Duplicate `CommandID` | `SeenCommand` short-circuits; the original events are returned |
| Store error reaching HTTP | `handleStoreErr()`; `{"error":"message"}` envelope, never raw SQL |

## Testing

- **Decider** — table-driven, no mocks, no database, no agent process. Port
  the skeleton's four scenarios (lifecycle, idempotency, double-tap, replay
  determinism) and extend.
- **`TestReplayDeterministic`** is the regression guard for the whole
  event-sourcing contract: replay from event 0 must produce byte-identical
  state. It must survive the swap from `memStore` to SQLite unchanged.
- **Claude adapter** — driven against recorded NDJSON fixtures over a fake
  stdio pipe, so tests never spawn a real `claude`. Fixtures are captured
  from the CLI version being targeted.
- **Frontend pure logic** — `eventReducer`, `timeline`, `scrollAnchoring`
  unit-tested directly, including out-of-order and dropped-`Sequence` cases.
- **Verification** — `go vet ./...`, `go test ./... -race`,
  `npm run typecheck`.

> **Verifying in this repo:** much of the app is untracked, and the
> pre-commit hook runs an unscoped full-project typecheck. Verify against
> the working tree, not a clean `HEAD` checkout, and expect the hook to
> block a commit for pre-existing errors outside the task's own files.

## Risks

**The Claude adapter is the riskiest component in this spec.** HANDOFF
explicitly recommends *against* Claude as the first adapter from Go: the
fully-supported path is the TypeScript SDK, `stream-json` shifts between CLI
versions, and approvals ride control-requests multiplexed into the output
stream. This was chosen anyway because Claude is the daily driver. Two
mitigations: pin fixtures to the targeted CLI version, and treat any
unparseable message as a `RuntimeWarning` carrying `Raw` rather than a
crash.

**`pi` is undocumented in HANDOFF.** It exposes `--mode rpc`, `--print`,
`--session-id`, and `--continue`, but the protocol has not been verified.
Spec 3 must begin with a protocol spike, not an adapter.

**The abstraction is unproven until spec 3.** The second adapter is where a
provider-agnostic event layer is actually tested. Every change spec 3 forces
on `event/` or `provider/` must be recorded — each one names an assumption
imported from Claude without noticing.
