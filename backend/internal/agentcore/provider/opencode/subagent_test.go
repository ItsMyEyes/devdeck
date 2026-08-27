package opencode

import (
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// OpenCode spawns a subagent as a CHILD SESSION: the parent calls the `task`
// tool and the server creates a session whose `info.parentID` names the
// parent. Before this, the whole `session.next.tool.*` family fell to the
// parser's default and produced one RuntimeWarning per event — a single
// subagent turn was a wall of parser errors — and the child session's own
// stream was dropped for naming a session the adapter did not own.

func ocState() *parseState {
	return newParseState("w-abc", "ses_parent", "opencode:default")
}

func ocTaskEvents(evts []event.Event) []event.Event {
	var out []event.Event
	for _, e := range evts {
		switch e.Type {
		case event.TaskStarted, event.TaskProgress, event.TaskUpdated, event.TaskCompleted:
			out = append(out, e)
		}
	}
	return out
}

func ocWarnings(evts []event.Event) int {
	n := 0
	for _, e := range evts {
		if e.Type == event.RuntimeWarning {
			n++
		}
	}
	return n
}

func TestTheTaskToolSpawnsAnAgentInsteadOfWarning(t *testing.T) {
	st := ocState()
	evts := parseEvent([]byte(`{"type":"session.next.tool.called","data":{
	  "sessionID":"ses_parent","assistantMessageID":"msg_1","callID":"call_1","tool":"task",
	  "input":{"description":"Explore the auth flow","subagent_type":"explore","prompt":"Map every auth entry point"}}}`), st)

	if n := ocWarnings(evts); n != 0 {
		t.Fatalf("the task tool produced %d warnings, want none: %+v", n, evts)
	}
	tasks := ocTaskEvents(evts)
	if len(tasks) != 1 || tasks[0].Type != event.TaskStarted {
		t.Fatalf("task events = %+v, want one task.started", tasks)
	}
	if tasks[0].AgentID != "call_1" {
		t.Errorf("AgentID = %q, want the tool call id", tasks[0].AgentID)
	}
	p := tasks[0].Payload.(*event.TaskStartedPayload)
	if p.Title != "Explore the auth flow" {
		t.Errorf("Title = %q", p.Title)
	}
	if p.Role != "explore" {
		t.Errorf("Role = %q, want the subagent_type", p.Role)
	}
	if p.Depth != 1 {
		t.Errorf("Depth = %d, want 1", p.Depth)
	}
}

// An ordinary tool must still render as an ordinary tool row — the whole
// family used to warn, so this pins that the fix covers both halves.
func TestAnOrdinaryToolBecomesATranscriptRow(t *testing.T) {
	st := ocState()
	evts := parseEvent([]byte(`{"type":"session.next.tool.called","data":{
	  "sessionID":"ses_parent","assistantMessageID":"msg_1","callID":"call_9","tool":"bash",
	  "input":{"command":"go test ./..."}}}`), st)

	if n := ocWarnings(evts); n != 0 {
		t.Fatalf("an ordinary tool produced %d warnings: %+v", n, evts)
	}
	var titled bool
	for _, e := range evts {
		if p, ok := e.Payload.(*event.ItemStartedPayload); ok {
			if p.Title != "bash" {
				t.Errorf("Title = %q, want bash", p.Title)
			}
			titled = true
		}
		if e.AgentID != "" {
			t.Errorf("an ordinary tool was attributed to agent %q", e.AgentID)
		}
	}
	if !titled {
		t.Fatalf("no tool row emitted: %+v", evts)
	}
}

func TestTaskProgressAndCompletionCloseTheAgentOut(t *testing.T) {
	st := ocState()
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{
	  "sessionID":"ses_parent","callID":"call_1","tool":"task",
	  "input":{"description":"Explore","subagent_type":"explore"}}}`), st)

	progress := ocTaskEvents(parseEvent([]byte(`{"type":"session.next.tool.progress","data":{
	  "sessionID":"ses_parent","callID":"call_1"}}`), st))
	if len(progress) != 1 || progress[0].Type != event.TaskProgress {
		t.Fatalf("progress = %+v, want one task.progress", progress)
	}
	if p := progress[0].Payload.(*event.TaskProgressPayload); p.Role != "explore" {
		t.Errorf("progress lost its identity: %+v", p)
	}

	done := ocTaskEvents(parseEvent([]byte(`{"type":"session.next.tool.success","data":{
	  "sessionID":"ses_parent","callID":"call_1",
	  "content":[{"type":"text","text":"Found three entry points."}]}}`), st))
	if len(done) != 1 || done[0].Type != event.TaskCompleted {
		t.Fatalf("completion = %+v, want one task.completed", done)
	}
	p := done[0].Payload.(*event.TaskCompletedPayload)
	if p.Status != event.TaskStatusCompleted {
		t.Errorf("Status = %q", p.Status)
	}
	if p.Summary != "Found three entry points." {
		t.Errorf("Summary = %q, want the task tool's own result", p.Summary)
	}
}

// The global bus repeats the per-session stream, so a terminal frame can
// arrive twice. Ending the same agent twice would show it completing twice.
func TestASecondTerminalFrameDoesNotEndTheAgentAgain(t *testing.T) {
	st := ocState()
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{"sessionID":"ses_parent","callID":"call_1","tool":"task","input":{}}}`), st)
	frame := []byte(`{"type":"session.next.tool.success","data":{"sessionID":"ses_parent","callID":"call_1","content":[{"type":"text","text":"done"}]}}`)

	if got := ocTaskEvents(parseEvent(frame, st)); len(got) != 1 {
		t.Fatalf("first terminal frame produced %d task events, want 1", len(got))
	}
	if got := ocTaskEvents(parseEvent(frame, st)); len(got) != 0 {
		t.Fatalf("the repeated terminal frame produced %d task events, want 0", len(got))
	}
}

// An operator's Stop surfaces as a failure whose message says so; telling
// them their agent failed would be wrong.
func TestAnAbortedTaskReadsAsStoppedNotFailed(t *testing.T) {
	st := ocState()
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{"sessionID":"ses_parent","callID":"call_1","tool":"task","input":{}}}`), st)
	done := ocTaskEvents(parseEvent([]byte(`{"type":"session.next.tool.failed","data":{
	  "sessionID":"ses_parent","callID":"call_1","error":{"message":"AbortError: aborted by user"}}}`), st))

	if len(done) != 1 {
		t.Fatalf("task events = %+v, want one", done)
	}
	if p := done[0].Payload.(*event.TaskCompletedPayload); p.Status != event.TaskStatusStopped {
		t.Errorf("Status = %q, want stopped", p.Status)
	}
}

// A child session gets its own parse state so every event it produces is
// attributed without any call site having to remember.
func TestAChildSessionsWorkIsAttributedToItsAgent(t *testing.T) {
	parent := ocState()
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{
	  "sessionID":"ses_parent","assistantMessageID":"msg_1","callID":"call_1","tool":"task",
	  "input":{"description":"Explore","subagent_type":"explore"}}}`), parent)

	sp := parent.bindChildSession("ses_child")
	if sp == nil {
		t.Fatal("the child session did not bind to the waiting spawn")
	}
	child := newChildParseState(parent, "ses_child", sp)

	evts := parseChildEvent([]byte(`{"type":"session.next.text.ended","data":{
	  "sessionID":"ses_child","assistantMessageID":"msg_child","textID":"text-0","text":"I found three entry points."}}`), child)

	if len(evts) == 0 {
		t.Fatal("the child session produced no events at all — its transcript is being dropped")
	}
	for _, e := range evts {
		if e.AgentID != "call_1" {
			t.Errorf("child event %s carried AgentID %q, want call_1", e.Type, e.AgentID)
		}
	}
}

// A subagent finishing must not settle the PARENT thread: the parent is still
// working, and an idle status would end its turn underneath it.
func TestAChildSessionsTurnLifecycleIsNotForwarded(t *testing.T) {
	parent := ocState()
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{"sessionID":"ses_parent","callID":"call_1","tool":"task","input":{}}}`), parent)
	sp := parent.bindChildSession("ses_child")
	child := newChildParseState(parent, "ses_child", sp)

	for _, frame := range []string{
		`{"type":"session.next.step.started","data":{"sessionID":"ses_child","assistantMessageID":"m1"}}`,
		`{"type":"session.next.step.ended","data":{"sessionID":"ses_child","finish":"stop"}}`,
	} {
		if evts := parseChildEvent([]byte(frame), child); len(evts) != 0 {
			t.Errorf("a child turn frame produced %+v, want nothing", evts)
		}
	}
}

// The parent's own turn id must survive a child's messages, or every
// subsequent parent event points at a turn the orchestrator never heard of.
func TestAChildSessionDoesNotRepointTheParentsTurn(t *testing.T) {
	parent := ocState()
	parent.setTurnID("msg_parent_turn")
	parseEvent([]byte(`{"type":"session.next.tool.called","data":{"sessionID":"ses_parent","callID":"call_1","tool":"task","input":{}}}`), parent)
	sp := parent.bindChildSession("ses_child")
	child := newChildParseState(parent, "ses_child", sp)

	parseChildEvent([]byte(`{"type":"session.next.text.ended","data":{
	  "sessionID":"ses_child","assistantMessageID":"msg_child","textID":"t0","text":"hi"}}`), child)

	if got := child.currentTurn(); got != "msg_parent_turn" {
		t.Fatalf("child turn = %q, want the parent's %q", got, "msg_parent_turn")
	}
}

// The tool input family streams raw JSON fragments; rendering half-written
// arguments is worse than waiting for tool.called's parsed copy.
func TestToolInputStreamingFramesAreSilent(t *testing.T) {
	st := ocState()
	for _, typ := range []string{
		"session.next.tool.input.started", "session.next.tool.input.delta",
		"session.next.tool.input.ended", "session.next.agent.switched",
	} {
		evts := parseEvent([]byte(`{"type":"`+typ+`","data":{"sessionID":"ses_parent"}}`), st)
		if len(evts) != 0 {
			t.Errorf("%s produced %+v, want nothing", typ, evts)
		}
	}
}
