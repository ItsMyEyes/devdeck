// Subagent support for the opencode provider.
//
// OpenCode models a subagent as a **child session**: the parent calls the
// `task` tool, the server creates a new session whose `info.parentID` names
// the parent, and the child's whole turn then streams under its own
// `sessionID`. Verified against opencode 1.18.18 — `opencode agent list`
// shows `explore` and `general` with `mode=subagent`, and the binary's own
// tool renderer reads `input.subagent_type`.
//
// Two consequences shape everything here:
//
//   - The child's stream is unreachable from the per-session subscription
//     (`/api/session/{parent}/event`). It arrives only on the GLOBAL bus,
//     which the adapter already subscribes to, and where a frame naming an
//     unknown session used to be silently dropped — taking the subagent's
//     entire transcript with it. `registerChild` + `parseChildEvent` are the
//     re-homing path.
//
//   - There is no lifecycle event for the task itself. The `task` tool call
//     IS the subagent's life: `tool.called` starts it, `tool.progress` ticks
//     it, `tool.success`/`tool.failed` ends it. So the canonical task.* events
//     are synthesised from that tool's own frames — see taskSpawn.
package opencode

import (
	"encoding/json"
	"strings"

	"devdeck/backend/internal/agentcore/event"
)

// taskToolName is opencode's spawn tool. The binary renders it as
// `# ${subagent_type} Task` and keys the agent off `input.subagent_type`;
// DevDeck's own permission list already names `task` among opencode's
// gated actions.
const taskToolName = "task"

// taskSpawn is one in-flight `task` tool call, i.e. one subagent.
//
// Keyed by the tool CALL id rather than by the child session id, because the
// call is the only thing that exists at spawn time: opencode creates the
// child session moments later and never names it in the parent's stream. The
// two are joined the other way round — `session.created` carries
// `info.parentID`, which the adapter uses to point the child's frames back
// here (see registerChild).
type taskSpawn struct {
	// callID is the grouping key: it is this subagent's AgentID everywhere,
	// including on the child session's own events once they are re-homed.
	callID string
	// title/role come from the tool's input — `description` and
	// `subagent_type`.
	title string
	role  string
	// prompt is what the subagent was actually asked to do.
	prompt string
	depth  int
	// childSessionID is filled in when the child announces itself. Empty
	// until then, and empty forever for a spawn whose child was never
	// observed — which is why nothing here depends on having it.
	childSessionID string
}

// taskInput is the `task` tool's own arguments. Field names verified against
// the running server's tool renderer (`t.input.subagent_type||"general"`).
type taskInput struct {
	Description  string `json:"description"`
	Prompt       string `json:"prompt"`
	SubagentType string `json:"subagent_type"`
}

// spawnDescription is what the agent row is titled. Prefers the caller's own
// one-line description; falls back to a trimmed prompt, because a row titled
// only "task" tells the operator nothing about what was delegated.
func spawnDescription(in taskInput) string {
	if d := strings.TrimSpace(in.Description); d != "" {
		return d
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return "Subagent"
	}
	if i := strings.IndexByte(prompt, '\n'); i > 0 {
		prompt = prompt[:i]
	}
	const maxTitle = 80
	if len([]rune(prompt)) > maxTitle {
		return string([]rune(prompt)[:maxTitle]) + "…"
	}
	return prompt
}

// taskStatusFrom maps a tool outcome onto the canonical vocabulary. opencode
// reports no distinct "stopped": an aborted turn surfaces as a failure whose
// message says so, which is the one case worth telling apart — an operator
// who pressed Stop must not be told their agent failed.
func taskStatusFrom(failed bool, message string) event.TaskStatus {
	if !failed {
		return event.TaskStatusCompleted
	}
	m := strings.ToLower(message)
	if strings.Contains(m, "abort") || strings.Contains(m, "cancel") {
		return event.TaskStatusStopped
	}
	return event.TaskStatusFailed
}

func (st *parseState) rememberSpawn(sp *taskSpawn) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.spawns = append(st.spawns, sp)
}

// peekSpawn finds an in-flight spawn without retiring it — for progress ticks,
// which can arrive many times before the call ends.
func (st *parseState) peekSpawn(callID string) *taskSpawn {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, sp := range st.spawns {
		if sp.callID == callID {
			return sp
		}
	}
	return nil
}

// takeSpawn retires a spawn on its terminal frame, so a duplicate
// success/failed (the global bus repeats the per-session stream) cannot end
// the same agent twice.
func (st *parseState) takeSpawn(callID string) *taskSpawn {
	st.mu.Lock()
	defer st.mu.Unlock()
	for i, sp := range st.spawns {
		if sp.callID == callID {
			st.spawns = append(st.spawns[:i], st.spawns[i+1:]...)
			return sp
		}
	}
	return nil
}

// bindChildSession attaches a child session id to the spawn still waiting for
// one — the oldest unbound spawn, since opencode creates the child immediately
// after the call and a parent rarely has two unbound spawns at once. Reports
// the owning spawn so the caller can key the child's events by its callID.
func (st *parseState) bindChildSession(childSessionID string) *taskSpawn {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, sp := range st.spawns {
		if sp.childSessionID == "" {
			sp.childSessionID = childSessionID
			return sp
		}
	}
	return nil
}

// taskSpawned turns a `task` tool call into a subagent announcement.
//
// It deliberately emits NO ItemStarted for the call itself: the agent's own
// row (the client anchors it on `toolCallId`) is that row, and emitting both
// would show the spawn twice.
func (st *parseState) taskSpawned(d toolEvent) []event.Event {
	var in taskInput
	if len(d.Input) > 0 {
		_ = json.Unmarshal(d.Input, &in)
	}
	sp := &taskSpawn{
		callID: d.CallID,
		title:  spawnDescription(in),
		role:   strings.TrimSpace(in.SubagentType),
		prompt: strings.TrimSpace(in.Prompt),
		depth:  st.depth + 1,
	}
	if sp.role == "" {
		// The server's own default when the caller names none.
		sp.role = "general"
	}
	st.rememberSpawn(sp)

	e := st.envelope(event.TaskStarted)
	e.AgentID = sp.callID
	e.Payload = &event.TaskStartedPayload{
		TaskID:     sp.callID,
		ToolCallID: sp.callID,
		Title:      sp.title,
		Role:       sp.role,
		Prompt:     sp.prompt,
		Depth:      sp.depth,
	}
	return []event.Event{e}
}

// taskProgressed is a liveness tick. opencode's tool.progress carries the
// output so far rather than a status line, and re-sending a growing blob on
// every tick would be a transcript of its own — so this reports only that the
// agent is alive, with the identity a late-joining client needs.
func (st *parseState) taskProgressed(sp *taskSpawn) []event.Event {
	e := st.envelope(event.TaskProgress)
	e.AgentID = sp.callID
	e.Payload = &event.TaskProgressPayload{TaskID: sp.callID, Title: sp.title, Role: sp.role}
	return []event.Event{e}
}

// taskFinished closes the agent out, carrying its report back to the parent —
// the `task` tool's own result, which is the only thing the parent actually
// consumes.
func (st *parseState) taskFinished(sp *taskSpawn, status event.TaskStatus, summary string) []event.Event {
	e := st.envelope(event.TaskCompleted)
	e.AgentID = sp.callID
	e.Payload = &event.TaskCompletedPayload{
		TaskID:  sp.callID,
		Status:  status,
		Title:   sp.title,
		Role:    sp.role,
		Summary: strings.TrimSpace(summary),
	}
	return []event.Event{e}
}

// newChildParseState builds the state a re-homed CHILD session's frames are
// parsed with.
//
// It shares the parent's thread id — a subagent's work belongs to the same
// DevDeck conversation — but carries the owning spawn's callID as a fixed
// AgentID, so every event it produces is attributed without any call site
// having to remember to stamp it.
//
// `pinTurn` is what stops the child from rewriting the parent's turn: a child
// session's assistant message ids are its own, and letting them through
// setTurnID would repoint every subsequent parent event at a turn the
// orchestrator has never heard of.
func newChildParseState(parent *parseState, childSessionID string, sp *taskSpawn) *parseState {
	st := newParseState(parent.threadID, childSessionID, parent.instanceID)
	st.agentID = sp.callID
	st.depth = sp.depth
	st.pinTurn = true
	st.turnID = parent.currentTurn()
	return st
}

// parseChildEvent parses one frame that arrived on a CHILD session's stream.
//
// Only the child's own narrative is kept. Its turn lifecycle is deliberately
// dropped: a subagent's `step.started`/`step.ended` are not the parent turn's,
// and forwarding them would settle the parent thread to idle the moment the
// subagent finished — while the parent is still working.
func parseChildEvent(line []byte, st *parseState) []event.Event {
	var ev sseEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return nil
	}
	switch ev.Type {
	case "session.next.step.started", "session.next.step.ended", "session.next.step.failed":
		return nil
	}
	return parseEvent(line, st)
}
