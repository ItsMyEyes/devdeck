# Subagent observability — design

**Date:** 2026-08-26
**Status:** implemented 2026-08-27 across all four providers. Verified by unit
tests per provider, a fixture cut from the live capture, and
`make e2e-agent-chat` (a real browser against an isolated server).

**Found while implementing — unrelated to subagents, fixed here:**
`codex/adapter.go` handed `parseNotification` only the `params` object, but
the parser switches on the envelope's own `method`. Every codex notification
therefore arrived with an empty method, fell to the parser's `default:`, and
came back as `unrecognized codex notification ""` — meaning the **codex
transcript was, in production, nothing but warnings**: no assistant text, no
tool calls, no turn lifecycle. The package's own tests missed it because they
rebuild `{method, params}` before calling in, exercising a shape the adapter
never produced. Fixed, with a regression test that walks the adapter's decode
rather than the parser's
(`TestTheAdapterHandsTheParserAWholeNotificationLine`).

## Problem

Every CLI agent DevDeck drives can spawn subagents. DevDeck models none of
them. What the operator sees today, per provider:

| Provider | What a subagent does to the transcript today |
|---|---|
| **claude** | One opaque `Agent` tool row. The subagent's text, reasoning and tool calls never reach DevDeck at all — the CLI drops them unless `--forward-subagent-text` is passed, and `buildArgs` does not pass it. A ten-minute subagent is ten minutes of a chat pane showing nothing. |
| **codex** | **Silent corruption.** `itemTypeOf`'s `default:` maps `subAgentActivity` and `collabAgentToolCall` to `ItemToolCall` with no title and `Detail: null` — blank, unlabelled rows in the main transcript. The child thread's own events are dropped without a warning (`adapter.go`, `s == nil`). `multi_agent` is **stable and on by default** in codex 0.145.0. |
| **opencode** | A `RuntimeWarning` per event for the whole `session.next.tool.*` family, so one subagent turn is a burst of warnings. The child session's stream is unreachable from the per-session subscription. |
| **pi** | An opaque tool row. `tool_execution_update` is deliberately dropped, so all progress is invisible. Least bad — nothing is misattributed. |

The canonical taxonomy already reserves `task.started` / `task.progress` /
`task.updated` / `task.completed` (`event/event.go`), copied from t3code. No
adapter has ever emitted one and no consumer has ever handled one.

## Evidence

Everything below was live-captured against the installed binaries, not read
from vendor docs. Raw captures: `capture/subagent/` (see its README).

### claude 2.1.246 — the wire contract

- **Attribution is `parent_tool_use_id`**, a top-level envelope field,
  `string | null`. Non-null means "produced inside the subagent started by
  that `tool_use.id`". Present on `user`, `assistant`, `stream_event`,
  `tool_progress`; **absent entirely** (not null) on `system/*`, `result`,
  `rate_limit_event`.
- **`--forward-subagent-text` is mandatory.** Its own help text: *"Forward
  subagent text and thinking blocks as assistant/user messages with
  parent_tool_use_id set (only works with --print and
  --output-format=stream-json)"*. Without it only the subagent's
  `tool_use`/`tool_result` frames arrive; with it, its narration does too.
- **The spawn tool is named `Agent` on the wire**, though `system/init`
  advertises the string `Task` in its tool list. Accept both.
- **`stream_event` never carries a non-null `parent_tool_use_id`** — 0 of 179
  frames across three captures. Subagent content arrives only as whole
  `assistant`/`user` frames. **A subagent transcript can never be
  token-streamed; it fills in per message.**
- Lifecycle is four `system` subtypes keyed by `task_id` + `tool_use_id`:
  `task_started` (`description`, `subagent_type`, `spawn_depth`, `task_type`,
  `prompt`), `task_progress` (`description`, `last_tool_name`, cumulative
  `usage`), `task_updated` (`patch.status`), `task_notification` (`status` ∈
  completed|failed|stopped, `summary`, `output_file`, `usage`).
- Subagent-attributed frames carry `subagent_type` and `task_description`
  alongside the id, so a row is self-describing without correlating back to
  `task_started`.
- **A spawn can be retracted.** After a `model_refusal_fallback` an `Agent`
  `tool_use` was emitted and then superseded (a later frame's `supersedes[]`
  carrying its uuid), with no `task_started` ever arriving. Treat a subagent
  as live only once `task_started` lands.
- `result.usage` excludes subagent tokens; `result.subagent_stats` summarises
  the fleet.

### t3code — the reference implementation

t3code (`gg/t3code`) solves this with a **flat stream plus attribution**, not
nested threads: a `Map<taskId, AgentState>` where `toolUseId` comes from
`task_started`, and any incoming `parent_tool_use_id` reverse-resolves to the
owning `taskId`. Its lessons, adopted here:

- **Repeat full identity on every `task.*` row**, not just the start —
  activity retention ages the start row out and the fold must still be able to
  reconstruct the agent.
- **Stamp attribution on `item.started`, `item.updated` and `item.completed`
  alike** — the client filters on it, so a miss on any one leaks the row.
- **Fold subagent usage into the parent's context meter with `max`, never
  `sum`** — the counters are cumulative and overlapping.
- **Stop means stop everything** — stop live tasks before interrupting the
  parent turn, or a runaway fleet keeps burning tokens.
- t3code **discards** the subagent's narration and renders a separate
  right-panel "Agents" roster (its "quiet-timeline guarantee").
- **Gap t3code left open:** approvals raised inside a subagent are completely
  unattributed — the SDK hands over `agentID` and t3code never reads it.

### Where this design deliberately differs from t3code

t3code throws the subagent's transcript away and puts a roster in a separate
panel. DevDeck keeps the transcript and renders it **inline, folded**, under
the spawning tool row.

Two reasons. DevDeck's chat is a single pane inside a tile layout — it has no
right-panel surface to spend, and adding one to answer "what is my subagent
doing" is a large amount of chrome for one question. And the operator's actual
question *is* "what did it do": a roster answers "how many and how far", a
folded transcript answers both, because the summary line is the roster row.

The quiet-timeline property is preserved exactly — a subagent contributes
**one** row to the main flow whatever it does inside.

## Design

### 1. Canonical model (`event` package)

One new envelope field, mirroring `Refs.SubAgentID` which `gg/agentcore`
declared and never used:

```go
type Event struct {
    ...
    // AgentID names the SUBAGENT that produced this event, empty for the
    // parent conversation. Every layer above the provider treats it as an
    // opaque grouping key.
    AgentID string `json:"agentId,omitempty"`
}
```

Payloads for the four reserved task types, with identity repeated on all of
them (t3code's retention lesson) and a shared usage struct:

```go
type TaskUsage struct {
    TotalTokens int64; ToolUses int64; DurationMs int64
}
type TaskStartedPayload struct {
    TaskID, ToolCallID, Title, Role, Prompt string
    Depth int; Backgrounded bool
}
type TaskProgressPayload struct {
    TaskID, Title, Role, LastToolName string; Usage *TaskUsage
}
type TaskUpdatedPayload struct { TaskID, Status string }
type TaskCompletedPayload struct {
    TaskID, Status, Summary, OutputFile, Title, Role string; Usage *TaskUsage
}
```

`Status` is normalised to one vocabulary across providers:
`running | completed | failed | stopped`.

### 2. claude adapter

- `buildArgs` gains `--forward-subagent-text`. It is accepted by every build
  that supports subagents and the CLI ignores unknown output-shaping flags on
  older ones only if they exist — so this is gated on nothing, matching how
  `--include-partial-messages` is already passed unconditionally.
- `wireLine` gains `ParentToolUseID *string` (pointer: absent and null are
  different), `SubagentType`, `TaskDescription`.
- `parseSystem` gains the four `task_*` subtypes → `Task*` events, and
  registers `taskID → {toolUseID, role, title}` in parse state.
- `parseAssistant` inverts for subagent frames: today it emits nothing for a
  parent `assistant` frame because `stream_event` already streamed that text.
  A frame with a non-null `parent_tool_use_id` has **no** matching
  `stream_event`, so it is the only copy — its blocks become real events:
  `text` → `ContentDelta{StreamText}`, `thinking` → `ContentDelta{StreamReasoning}`,
  `tool_use` → `ItemStarted` + `ItemCompleted`, each stamped with `AgentID`.
- Item ids for subagent content are `<frame uuid>#<block index>` — unique,
  and stable across a replay because the uuid is in the frame.
- `user` frames with a `parent_tool_use_id` are skipped: the first is the
  subagent's seed prompt (already visible on the parent's tool row) and the
  rest are `tool_result`s, which this adapter does not render for the parent
  either. Keeping the two consistent matters more than the extra detail.

### 3. codex adapter

- `itemTypeOf` gains explicit cases so `subAgentActivity` and
  `collabAgentToolCall` stop falling through to a blank `ItemToolCall`.
- `subAgentActivity` → `Task*` keyed by `agentThreadId`; `kind` maps
  `started → task.started`, `interacted → task.progress`,
  `interrupted → task.completed{stopped}`.
- `collabAgentToolCall` → a titled tool item (`spawnAgent`, `sendInput`, …)
  carrying `prompt`/`model`, and for `spawnAgent` the `receiverThreadIds`
  register those child threads against this parent.
- Child-thread routing: a notification whose `threadId` is a registered child
  is re-homed onto the parent's session with `AgentID` set, instead of being
  dropped at `s == nil`.

### 4. opencode adapter

- The `session.next.tool.*` family stops warning: `tool.called` with
  `tool == "task"` → `task.started` (role from `input.subagent_type`), other
  tools → the existing tool-item path; `tool.progress` → `task.progress` when
  it belongs to a task.
- `session.created` carrying `info.parentID` registers the child session
  against the parent thread, so the global bus can re-home the child's
  `session.next.*` events with `AgentID` instead of dropping them.

### 5. pi adapter

`tool_execution_update` is currently dropped wholesale. For the subagent tool
it becomes `task.progress` (using `partialResult` as the progress line), which
is the only progress signal pi offers. Everything else stays dropped.

### 6. Orchestration

- `AssistantDeltaPayload` gains `AgentID`; `assistantBuffer` carries it so a
  flush cannot lose it (`flushThread` rebuilds a bare event today).
- `noteSignal` counts `TaskStarted` as output, so a turn whose only visible
  work is a subagent is never reported as silent.
- Task events need no new command type: they ride `CmdThreadActivityAppend`
  through `handle`'s default branch like every other forwarded provider event,
  so the durable log and the replay path are unchanged.
- No new `Thread` state. The subagent roster is **derived in the client** from
  the same durable events, which makes it replay-correct by construction and
  keeps the engine's read model untouched.

### 7. Frontend

- `ChatItem` gains `agentId?: string`.
- `AgentThreadView` gains `subagents: SubagentRecord[]` — `{id, toolCallId,
  title, role, status, lastTool, progress, summary, usage, startedAt,
  updatedAt}` — folded by the reducer from the `task.*` events.
- `timeline.ts` gains a `subagent` entry. A tool item whose `toolCallId`
  matches a subagent's becomes that entry; every item carrying that
  `agentId` is absorbed into it and removed from the main flow. Result: one
  row per subagent in the main timeline, whatever happens inside.
- `MessagesTimeline` renders it with the vendored `Task` collapsible already
  used for the "N earlier steps" fold: a status dot, the role, the
  description, and `Σ tokens · N tools`; expanding shows the subagent's own
  transcript — its text, reasoning and tool rows — indented.

## Testing

- Go: a fixture cut from the real capture
  (`provider/claude/testdata/subagent.ndjson`) driven through `parseLine`,
  asserting attribution, lifecycle and that no parent row is polluted. Table
  tests for codex/opencode/pi mappings. A regression test that `buildArgs`
  carries `--forward-subagent-text`.
- Frontend: reducer tests for the roster fold and item attribution; timeline
  tests for the absorb-into-one-row invariant (t3code's own test asserts
  exactly this); a render test that the group expands to the subagent's work.
- E2E: extend `scripts/e2e-agent-chat` with a fake-claude script that replays
  the captured subagent frames, asserting one folded row that expands.

## Non-goals

- Subagent **definition** management (`.claude/agents/*.md` browser/editor)
  alongside the existing Skills and MCP managers. Natural follow-up; not this.
- Attributing approvals raised inside a subagent. The claude CLI's
  `control_request` carries no agent field (verified — only the SDK's
  in-process `canUseTool` receives `agentID`), so there is nothing to read off
  the wire DevDeck consumes. Recorded here so the gap is known, not guessed at.
- Stop-the-fleet semantics (t3code's `stopTask` sweep). Worth doing, but it is
  a separate interrupt-path change with its own failure modes.
- Nested subagents (`spawn_depth > 1`) render flat — attributed to their own
  agent, not indented inside their parent agent.
