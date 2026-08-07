# Agent Chat t3code Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the agent chat surface to t3code layout parity, wire its controls to real commands, add a Sessions sidebar tab backed by real data, and fix the three critical defects that make the pane non-functional.

**Architecture:** Controls move out of the header into the composer footer as ghost pills. Threads are provisioned lazily on `hello` and bound to a live adapter by the Reactor. `agent_thread` gains a write side so sessions can be listed.

**Tech Stack:** Go 1.25, React 19, TypeScript 5.7, zustand, Vitest, Tailwind v4, `@base-ui/react`.

**Source spec:** `docs/superpowers/specs/2026-08-07-agent-chat-t3code-parity-design.md`
**Prior spec:** `docs/superpowers/specs/2026-08-07-agent-chat-pane-design.md`
**Visual reference:** `gg/t3code/apps/web/src/components/chat/` — read `ComposerControl.tsx` and `ChatHeader.tsx` before any frontend task.

## Global Constraints

**Event-sourcing invariants — unchanged from spec 1, do not weaken**
- `Decide(state, cmd, now, newID)` stays **pure**: no I/O, no `time.Now()`, no randomness. Adding cases must not change this.
- Order is **commit → swap state → publish**.
- `TestReplayDeterministic` must pass unchanged. If it breaks, the change is wrong.
- Route on `InstanceID`, never `Kind`. Never branch on `Raw`.
- Commands imperative dotted; events past-tense hyphenated.

**DevDeck conventions**
- Persistence through `port.Store`; handlers use `handleStoreErr`; `{"error":"message"}` envelope.
- SQLite uses `?` placeholders. Schema appended to `const schema` in `store/db.go` with `CREATE TABLE IF NOT EXISTS`; column additions need a `migrate*` function, following `migrateWorktreeColumns`.
- Logging is `log.Printf`.
- Frontend: `@/*` alias, `import type`, dark-only v2 tokens from `globals.css`, `lucide-react`, `cn()`, explicit loading/error/empty states.
- **Never edit `frontend/src/routeTree.gen.ts`.**

**Styling — take structure from t3code, colours from DevDeck**
Composer control pills mirror t3code's `composerControlClassName`:
`h-7 min-h-7 gap-1.5 px-2.5`, ghost variant, muted→foreground on hover, `size-3.5` chevron. Use DevDeck tokens (`devdeck-fg`, `devdeck-fg-2`, `devdeck-line`, `devdeck-pane`, `devdeck-on`), never t3code's.

**Test registration**
New frontend test files **must** be added to `test.include` in `frontend/vite.config.ts`. This project enumerates test files explicitly — an unregistered file silently never runs.

**Convergence files — serialize, one owner each**
`port/store.go` (Task 4) · `cmd/server/main.go` (Task 2) · `useDevDeckStore.ts` (Task 8) · `routeTree.gen.ts` (never)

**Verification**
`cd backend && go vet ./... && go test ./... -race` · `cd frontend && npm run typecheck && npx vitest run`
The pre-commit hook runs an unscoped full-project typecheck; if it blocks on pre-existing errors, commit `--no-verify` and say so. Note `src/features/editor/monacoLspClient.guard.test.ts` fails under full-suite load for pre-existing reasons unrelated to this work — do not chase it.

## File Structure

**Backend**

| File | Change |
|---|---|
| `agentcore/orchestration/engine.go` | +5 `Decide` cases, `InteractionModeSetPayload` |
| `agentcore/orchestration/command.go` | `EvtThreadCreated` into `IntentEvents` |
| `agentcore/orchestration/workers.go` | Reactor `EvtThreadCreated` case; unify session-stop routing |
| `agentcore/orchestration/decider_test.go` | Exhaustive command-coverage table test |
| `agentcore/orchestration/workers_test.go` | Reactor tests (currently none exist) |
| `store/db.go` | `agent_thread` columns + migration |
| `store/agentevent.go` | Insert `agent_thread` on `EvtThreadCreated`; `AgentThreads` returns rows |
| `port/store.go` | `AgentThreads` returns `[]domain.AgentThread` |
| `domain/agent.go` | `AgentThread` type |
| `handler/agent_ws.go` | Subscribe-before-snapshot; auto-create on `hello` |
| `handler/agent_thread.go` | `GET /api/agent/threads` |
| `handler/agent_ws_e2e_test.go` | The seam-crossing test spec 1 lacked |
| `cmd/server/main.go` | Register route |

**Frontend**

| File | Change |
|---|---|
| `agent-chat/ChatHeader.tsx` | Strip all four selects; title + status only |
| `agent-chat/ComposerControl.tsx` | **new** — ghost pill primitives |
| `agent-chat/ComposerControls.tsx` | **new** — the control row + overflow menu |
| `agent-chat/ChatComposer.tsx` | Bordered box, control row, circular send, meter |
| `agent-chat/ChatStatusStrip.tsx` | **new** — worktree / branch strip |
| `agent-chat/MessagesTimeline.tsx` | Collapse tool rows to 1; turn stamps |
| `agent-chat/timeline.ts` | `collapseWorkLog` |
| `agent-chat/SessionsPanel.tsx` | **new** — sessions list |
| `terminal/ShellSidebar.tsx` | Third tab |
| `store/useDevDeckStore.ts` | `ShellSidebarPanel` gains `'sessions'` |
| `features/data/queries.ts` | `useAgentThreads` |
| `vite.config.ts` | Register new test files |

---

### Task 1: Every command gets a decider rule

`Decide`'s `default` branch silently swallowed five command types. Tool calls never reach the store because Ingestion's fallback dispatches one of them, and `Reactor.reportError` fails for the same reason — so provider failures are invisible by the exact mechanism built to surface them.

**Files:**
- Modify: `backend/internal/agentcore/orchestration/engine.go`
- Modify: `backend/internal/agentcore/orchestration/decider_test.go`

**Interfaces:**
- Produces: `Decide` cases for `CmdThreadActivityAppend`, `CmdThreadAssistantComplete`, `CmdThreadTurnDiffComplete`, `CmdThreadInteractionModeSet`, `CmdThreadUserInputRespond`; `orchestration.InteractionModeSetPayload{Mode provider.InteractionMode}`.

- [ ] **Step 1: Write the failing exhaustive test**

Append to `decider_test.go`. This is the test whose absence hid the bug — it fails the moment a command type exists without a rule:

```go
// Every CommandType must have an explicit decider rule. The generic
// "unrecognized command" fallthrough is how five commands silently shipped
// broken, including the one Ingestion uses for every tool call.
func TestEveryCommandTypeHasADeciderRule(t *testing.T) {
	all := []CommandType{
		CmdThreadCreate, CmdThreadTurnStart, CmdThreadTurnInterrupt,
		CmdThreadApprovalRespond, CmdThreadUserInputRespond, CmdThreadSessionStop,
		CmdThreadRuntimeModeSet, CmdThreadInteractionModeSet, CmdThreadDelete,
		CmdThreadAssistantDelta, CmdThreadAssistantComplete, CmdThreadSessionSet,
		CmdThreadActivityAppend, CmdThreadTurnDiffComplete,
	}

	for _, ct := range all {
		s := createThread(t, NewState(), "w-abc")
		_, err := Decide(s, Command{
			CommandID: "ac-x", Type: ct, ThreadID: "w-abc",
			Payload: mustRaw(t, map[string]any{}),
		}, 1000, seqIDs())

		// A rule may legitimately reject bad input, but it must never report
		// the command as unknown.
		if err != nil && strings.Contains(err.Error(), "unrecognized command") {
			t.Errorf("%s has no decider rule", ct)
		}
	}
}

// Ingestion's fallback dispatches ActivityAppend for every provider event it
// doesn't explicitly handle — which is exactly what tool calls are.
func TestActivityAppendProducesAnEvent(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-act", Type: CmdThreadActivityAppend, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"itemType": "tool_call", "title": "Read"}),
	}, 2000, seqIDs())
	if err != nil {
		t.Fatalf("activity append: %v", err)
	}
	if len(evts) != 1 || evts[0].Type != EvtThreadActivityAppended {
		t.Fatalf("got %+v, want one thread.activity-appended", evts)
	}
}

func TestInteractionModeSetAppliesToState(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-im", Type: CmdThreadInteractionModeSet, ThreadID: "w-abc",
		Payload: mustRaw(t, InteractionModeSetPayload{Mode: provider.InteractionPlan}),
	}, 3000, seqIDs())
	if err != nil {
		t.Fatalf("interaction mode: %v", err)
	}
	s = Apply(s, evts)
	if th, _ := s.Thread("w-abc"); th.Interact != provider.InteractionPlan {
		t.Fatalf("interact = %s, want plan", th.Interact)
	}
}
```

Add `"strings"` to the imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -run TestEveryCommandType -v`
Expected: FAIL, naming the five commands with no rule.

- [ ] **Step 3: Implement the cases**

In `engine.go`, add `InteractionModeSetPayload` beside `RuntimeModeSetPayload` in `command.go`, then add to `Decide`'s switch:

- `CmdThreadActivityAppend`, `CmdThreadAssistantComplete`, `CmdThreadTurnDiffComplete` — pass-through, mirroring `CmdThreadSessionSet`'s shape: emit `EvtThreadActivityAppended` / `EvtThreadMessageSent` / `EvtThreadTurnDiffCompleted` carrying `cmd.Payload` verbatim.
- `CmdThreadInteractionModeSet` — mirror `CmdThreadRuntimeModeSet`: decode `InteractionModeSetPayload`, emit `EvtThreadInteractionModeSet`.
- `CmdThreadUserInputRespond` — mirror `CmdThreadApprovalRespond`: reject if the request is not pending, emit `EvtThreadUserInputResponseRequested`.

In `Apply`'s `applyOne`, add `EvtThreadInteractionModeSet` setting `t.Interact`.

Keep every case pure.

- [ ] **Step 4: Run until green**

Run: `cd backend && go vet ./... && go test ./internal/agentcore/... -race -v`
Expected: PASS, including `TestReplayDeterministic` unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/
git commit -m "fix(agentcore): give every command type a decider rule"
```

---

### Task 2: Provision threads so a turn can actually run

Nothing in production ever calls `StartInstance`, `Dir.Bind`, or `StartSession`, so every turn dies at `provider: thread %s is not bound to an instance`.

> Owns `backend/cmd/server/main.go`.

**Files:**
- Modify: `backend/internal/agentcore/orchestration/command.go` — `EvtThreadCreated` into `IntentEvents`
- Modify: `backend/internal/agentcore/orchestration/workers.go` — Reactor case; unify session-stop
- Create: `backend/internal/agentcore/orchestration/workers_reactor_test.go`
- Modify: `backend/cmd/server/main.go` — pass worktree lookup into the Reactor

**Interfaces:**
- Consumes: Task 1's decider cases.
- Produces: `Reactor.InstanceFor func(threadID string) (provider.InstanceID, provider.SessionStartInput, error)` — resolves a thread to the worktree's agent, cwd, and instance. Injected so the Reactor stays testable without a real worktree.

- [ ] **Step 1: Write the failing Reactor test**

`Reactor` has **zero** tests today. Create `workers_reactor_test.go` with a fake `provider.Service` whose `SendTurn` records calls and can be toggled to fail, then assert:

1. `EvtThreadCreated` calls `StartInstance` then `Bind` then `StartSession`, in that order.
2. A `turn.start` after creation reaches `SendTurn` with the thread bound.
3. A failing `SendTurn` appends exactly one visible error entry to the thread log (this is `reportError`, which Task 1 just unblocked).
4. `EvtThreadTurnInterruptRequested` calls `Broker.CancelThread` **before** `Provider.InterruptTurn`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -run TestReactor -v`
Expected: FAIL — no `EvtThreadCreated` case exists.

- [ ] **Step 3: Implement**

- Add `EvtThreadCreated: true` to `IntentEvents`.
- Add a `Reactor.react` case for `EvtThreadCreated`: resolve via `InstanceFor`, call `Registry.StartInstance` (treat "already running" as success — it is keyed by `InstanceID` and shared across threads), then `Dir.Bind`, then `Adapter.StartSession`. A failure here reports through `reportError`; the thread stays readable because `EvtThreadCreated` is already durable.
- Change `EvtThreadSessionStopRequested` to route through `r.Provider` like every other case, deleting `mustInstance`. Two thread→instance lookup mechanisms in one switch is a latent divergence.
- In `main.go`, build `InstanceFor` from the store: worktree id → `Worktree.Agent` → `InstanceID` `<agent>:default`, cwd → `Worktree.Path`.

- [ ] **Step 4: Run until green**

Run: `cd backend && go vet ./... && go test ./... -race`

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/ backend/cmd/server/main.go
git commit -m "feat(agentcore): provision and bind a thread's provider session"
```

---

### Task 3: Fix the replay race and auto-create on hello

`HandleWS` snapshots the store at line 99 and subscribes at line 113. Anything committed in that window is durably logged and delivered to neither — permanently invisible, because the client's cursor advances past it.

**Files:**
- Modify: `backend/internal/handler/agent_ws.go`
- Modify: `backend/internal/handler/agent_ws_test.go`

- [ ] **Step 1: Write the failing race test**

A test that wraps the store so `AgentEventsSince` blocks, dispatches a second command through the engine while blocked, releases, and asserts the client receives **both** events.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — the client sees only the first event.

- [ ] **Step 3: Implement**

Swap the order: `Subscribe` **first**, then snapshot, then write the snapshot, then drain the subscription. An event landing in the now-harmless window appears in both, as a duplicate `Seq` — which the frontend reducer already discards via `event.seq <= view.lastSeq`. This trades a silent permanent loss for an already-handled duplicate.

Then add auto-create: on `hello`, if the snapshot is empty, dispatch `thread.create` with `CommandID` `"ac-create-" + threadID` and the worktree's agent as `instanceId`. The derived id makes a reconnect idempotent via `SeenCommand` instead of erroring with "thread already exists".

- [ ] **Step 4: Run until green**

Run: `cd backend && go test ./internal/handler/ -race -v`

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/agent_ws.go backend/internal/handler/agent_ws_test.go
git commit -m "fix(agent): subscribe before snapshot; auto-create thread on hello"
```

---

### Task 4: Sessions data — write side and route

> Owns `backend/internal/port/store.go`.

**Files:**
- Modify: `backend/internal/domain/agent.go` — `AgentThread` type
- Modify: `backend/internal/store/db.go` — columns + migration
- Modify: `backend/internal/store/agentevent.go` — insert on `EvtThreadCreated`; `AgentThreads`
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/handler/agent_thread.go`
- Modify: `backend/internal/store/agentevent_test.go`

**Interfaces:**
- Produces: `domain.AgentThread{ID, WorktreeID, InstanceID, Title, AgentID, Model, Status, CreatedAt, UpdatedAt}`; `port.Store.AgentThreads(worktreeID string) ([]domain.AgentThread, error)`; `GET /api/agent/threads?worktree=<id>`.

- [ ] **Step 1: Write the failing store test**

Assert: committing an `EvtThreadCreated` writes exactly one `agent_thread` row in the **same transaction**; a rolled-back commit leaves none; `AgentThreads` filters by worktree and orders by `updated_at` descending; a thread with no further events still appears.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Add `title`, `agent_id`, `model`, `updated_at`, `status` to `agent_thread` via a `migrateAgentThreadColumns` function following `migrateWorktreeColumns`. In `CommitAgentEvents`, inside the existing transaction, `INSERT OR IGNORE` a row when an event's type is `EvtThreadCreated`, and bump `updated_at` for the thread on every commit. Keep it in the one transaction — spec 1's atomicity contract.

Then the handler: `GET /api/agent/threads?worktree=`, `handleStoreErr`, `{"error":"message"}` envelope. Register in `main.go`.

> `main.go` is Task 2's file. Coordinate: if Task 2 is already committed, this route registration is a small append; do not run these two tasks concurrently.

- [ ] **Step 4: Run until green** — `cd backend && go vet ./... && go test ./... -race`

- [ ] **Step 5: Commit**

```bash
git add backend/internal/domain/ backend/internal/store/ backend/internal/port/store.go backend/internal/handler/agent_thread.go backend/cmd/server/main.go
git commit -m "feat(agent): persist and list agent threads per worktree"
```

---

### Task 5: The end-to-end test spec 1 lacked

Every critical finding lived in the seam between layers, and every task's unit tests passed anyway. This is the test that would have caught all of them.

**Files:**
- Create: `backend/internal/handler/agent_ws_e2e_test.go`

- [ ] **Step 1: Write it**

One test, crossing WS → engine → reactor → directory → adapter with a fake driver that records calls:

1. Open `/ws/agent` with `hello` for a thread that has no events.
2. Assert the thread is auto-created and the fake adapter's `StartSession` is called.
3. Send `thread.turn.start`.
4. Assert the fake adapter's `SendTurn` receives it, with the mode from thread state.
5. Feed a `ContentDelta` and an `ItemStarted` (tool call) back through the adapter's event channel.
6. Assert **both** reach the client over the socket — the tool call is the one Task 1 unblocked.

- [ ] **Step 2: Run** — `cd backend && go test ./internal/handler/ -run E2E -race -v`

- [ ] **Step 3: Commit**

```bash
git add backend/internal/handler/agent_ws_e2e_test.go
git commit -m "test(agent): end-to-end turn across ws, engine, reactor, adapter"
```

---

### Task 6: Header and composer to t3code layout

Read `gg/t3code/apps/web/src/components/chat/ComposerControl.tsx` and `ChatHeader.tsx` first.

**Files:**
- Modify: `frontend/src/features/agent-chat/ChatHeader.tsx`
- Create: `frontend/src/features/agent-chat/ComposerControl.tsx`
- Modify: `frontend/src/features/agent-chat/ChatComposer.tsx`
- Create: `frontend/src/features/agent-chat/ChatStatusStrip.tsx`
- Create: `frontend/src/features/agent-chat/ChatComposer.test.tsx`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Produces: `ComposerControl`, `ComposerControlIcon`, `ComposerControlChevron`, `ComposerSelectControl`; `<ChatStatusStrip worktree branch />`.

- [ ] **Step 1: Write the failing composer test**

Assert: the composer renders a **circular icon send button**, not a labelled one; controls render on one row; at a narrow container the controls collapse into a `…` menu rather than wrapping; Enter sends and Shift+Enter does not.

Register the file in `vite.config.ts`'s `test.include`.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Strip the header**

Delete all four `Select`s and their state from `ChatHeader.tsx`. It keeps the icon, title, thread-suffix chip, and status dot. This alone removes ~430px of wrapped chrome.

- [ ] **Step 4: Build the pill primitives**

`ComposerControl.tsx`, mirroring t3code's `composerControlClassName` with DevDeck tokens:

```tsx
const composerControlClassName =
  'h-7 min-h-7 gap-1.5 px-2.5 text-devdeck-fg-2 transition-none hover:text-devdeck-fg'
```

- [ ] **Step 5: Restructure the composer**

Textarea and control row inside **one** bordered box. Send is a circular filled button with an up arrow (`ArrowUp` from lucide), becoming the interrupt control while running. Controls separated by thin vertical rules (`w-px h-4 bg-devdeck-line`). Add `ChatStatusStrip` below.

- [ ] **Step 6: Run until green** — `npm run typecheck && npx vitest run src/features/agent-chat/`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/ frontend/vite.config.ts
git commit -m "feat(agent-chat): t3code composer layout, header without pickers"
```

---

### Task 7: Wire the controls to real commands

**Files:**
- Create: `frontend/src/features/agent-chat/ComposerControls.tsx`
- Modify: `frontend/src/features/agent-chat/useAgentChatSocket.ts`
- Create: `frontend/src/features/agent-chat/ComposerControls.test.tsx`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: Task 1's decider cases.
- Produces: `AgentCommandType` gains `'thread.runtime-mode.set' | 'thread.interaction-mode.set'`; `setRuntimeMode`, `setInteractionMode` on the socket hook.

- [ ] **Step 1: Write the failing test**

Assert each pill dispatches its command with the right payload, and that a rejected command reverts the pill to the thread's actual mode rather than showing a state the agent isn't in.

- [ ] **Step 2–4: Implement, run, commit**

Model and effort ride the `thread.turn.start` payload. Runtime and interaction modes dispatch immediately. Effort and thinking are **one** control rendering `High · Normal`.

```bash
git commit -m "feat(agent-chat): dispatch mode and model changes to the engine"
```

---

### Task 8: Tool rows, turn stamps, sessions tab

> Owns `frontend/src/store/useDevDeckStore.ts`.

**Files:**
- Modify: `frontend/src/features/agent-chat/timeline.ts` + `timeline.test.ts`
- Modify: `frontend/src/features/agent-chat/MessagesTimeline.tsx`
- Create: `frontend/src/features/agent-chat/SessionsPanel.tsx` + test
- Modify: `frontend/src/features/terminal/ShellSidebar.tsx`
- Modify: `frontend/src/store/useDevDeckStore.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Produces: `collapseWorkLog(entries, maxVisible)` with `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`; `ShellSidebarPanel` gains `'sessions'`; `useAgentThreads(machine, worktreeId)`.

- [ ] **Step 1: Write the failing tests**

`collapseWorkLog`: with N tool entries exactly one is visible and the disclosure reports `N-1`; with one entry there is no disclosure. `SessionsPanel`: renders loading, error, and empty states, highlights the active thread, and folds older entries behind `Show more`.

- [ ] **Step 2–4: Implement, run, commit**

`ShellSidebar.tsx` line 75's `effectivePanel` guard must handle `'sessions'` — a shell with no worktree falls back to `'explorer'`, same as the existing `'git'` guard.

```bash
git commit -m "feat(agent-chat): collapse tool rows, turn stamps, sessions sidebar"
```

---

## Self-Review Notes

- Spec coverage: header → 6, composer → 6, controls wired → 7, tool rows → 8, sessions → 4 + 8, provisioning → 2 + 3, decider gap → 1, replay race → 3, seam test → 5.
- Task 4 and Task 2 both touch `main.go`; Task 2 owns it and Task 4 appends after. **These two must not run concurrently.** Tasks 6–8 are frontend-only and can run as a parallel chain against 1–5.
- Type consistency: `domain.AgentThread` defined in Task 4 is consumed in Task 8; `InteractionModeSetPayload` defined in Task 1 is dispatched in Task 7.
- Deferred by design, no task: the changed-files card (needs `TurnDiffUpdated`, spec 4), approval UI (spec 2), non-Claude adapters (spec 3).
