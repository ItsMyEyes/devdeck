package pi

import (
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// pi's subagent is an opt-in example extension that spawns a child process
// outside the RPC session, so its interior work is structurally unavailable
// (see subagent.go). All DevDeck can show is the tool's own lifecycle plus
// the `partialResult` it streams — and that stream was being dropped
// wholesale with every other tool_execution_update, which is what made a
// multi-minute fan-out a single motionless row.

func piState() *parseState {
	return newParseState("w-abc", "pi:default")
}

func feed(t *testing.T, st *parseState, line string) []event.Event {
	t.Helper()
	return parseLine([]byte(line), st)
}

func taskEvents(evts []event.Event) []event.Event {
	var out []event.Event
	for _, e := range evts {
		switch e.Type {
		case event.TaskStarted, event.TaskProgress, event.TaskUpdated, event.TaskCompleted:
			out = append(out, e)
		}
	}
	return out
}

func TestSubagentToolAnnouncesAnAgentAlongsideItsRow(t *testing.T) {
	st := piState()
	evts := feed(t, st, `{"type":"tool_execution_start","toolCallId":"call-1","toolName":"subagent",
	  "args":{"description":"Audit the handlers","agent":"reviewer","prompt":"Look for missing auth"}}`)

	tasks := taskEvents(evts)
	if len(tasks) != 1 || tasks[0].Type != event.TaskStarted {
		t.Fatalf("task events = %+v, want one task.started", tasks)
	}
	if tasks[0].AgentID != "call-1" {
		t.Errorf("AgentID = %q, want the tool call id", tasks[0].AgentID)
	}
	p := tasks[0].Payload.(*event.TaskStartedPayload)
	if p.Title != "Audit the handlers" {
		t.Errorf("Title = %q, want the description", p.Title)
	}
	if p.Role != "reviewer" {
		t.Errorf("Role = %q, want reviewer", p.Role)
	}
	if p.ToolCallID != "call-1" {
		t.Errorf("ToolCallID = %q — the client anchors the agent's row on it", p.ToolCallID)
	}

	// The ordinary tool row is still emitted: pi reports nothing about the
	// agent the call does not already carry, so suppressing it would only
	// lose the arguments disclosure.
	var sawItem bool
	for _, e := range evts {
		if e.Type == event.ItemStarted {
			sawItem = true
		}
	}
	if !sawItem {
		t.Error("the subagent's own tool row disappeared")
	}
}

// The regression this feature exists for.
func TestSubagentProgressIsSurfacedInsteadOfDropped(t *testing.T) {
	st := piState()
	feed(t, st, `{"type":"tool_execution_start","toolCallId":"call-1","toolName":"subagent","args":{"description":"Audit"}}`)
	evts := feed(t, st, `{"type":"tool_execution_update","toolCallId":"call-1","toolName":"subagent",
	  "partialResult":"reviewer: reading handlers/auth.go\nreviewer: reading handlers/user.go"}`)

	tasks := taskEvents(evts)
	if len(tasks) != 1 || tasks[0].Type != event.TaskProgress {
		t.Fatalf("task events = %+v, want one task.progress", tasks)
	}
	p := tasks[0].Payload.(*event.TaskProgressPayload)
	// The LAST line: partialResult is a growing blob, and "where is it now"
	// is its tail, not the whole thing.
	if p.Title != "reviewer: reading handlers/user.go" {
		t.Errorf("progress = %q, want the newest line of partialResult", p.Title)
	}
	if tasks[0].AgentID != "call-1" {
		t.Errorf("AgentID = %q, want the tool call id", tasks[0].AgentID)
	}
}

// The change must not widen: every other tool's update stays dropped, because
// there is no canonical item-updated event to carry it and the whole result
// arrives again on tool_execution_end.
func TestANonSubagentToolUpdateIsStillDropped(t *testing.T) {
	st := piState()
	evts := feed(t, st, `{"type":"tool_execution_update","toolCallId":"call-2","toolName":"bash","partialResult":"half the output"}`)
	if len(evts) != 0 {
		t.Fatalf("a bash update produced %+v, want nothing", evts)
	}
}

func TestSubagentCompletionCarriesItsReportBack(t *testing.T) {
	st := piState()
	feed(t, st, `{"type":"tool_execution_start","toolCallId":"call-1","toolName":"subagent","args":{"description":"Audit the handlers","agent":"reviewer"}}`)
	evts := feed(t, st, `{"type":"tool_execution_end","toolCallId":"call-1","toolName":"subagent","result":"Found two missing auth checks."}`)

	tasks := taskEvents(evts)
	if len(tasks) != 1 || tasks[0].Type != event.TaskCompleted {
		t.Fatalf("task events = %+v, want one task.completed", tasks)
	}
	p := tasks[0].Payload.(*event.TaskCompletedPayload)
	if p.Status != event.TaskStatusCompleted {
		t.Errorf("Status = %q, want completed", p.Status)
	}
	if p.Summary != "Found two missing auth checks." {
		t.Errorf("Summary = %q, want the tool's result", p.Summary)
	}
	// Identity survives from the start row, which is what lets a client that
	// joined late still render a complete agent.
	if p.Title != "Audit the handlers" || p.Role != "reviewer" {
		t.Errorf("terminal row lost its identity: title=%q role=%q", p.Title, p.Role)
	}
}

func TestAFailedSubagentIsReportedAsFailed(t *testing.T) {
	st := piState()
	feed(t, st, `{"type":"tool_execution_start","toolCallId":"call-1","toolName":"subagent","args":{}}`)
	evts := feed(t, st, `{"type":"tool_execution_end","toolCallId":"call-1","toolName":"subagent","isError":true,"result":"spawn failed"}`)

	tasks := taskEvents(evts)
	if len(tasks) != 1 {
		t.Fatalf("task events = %+v, want one", tasks)
	}
	if p := tasks[0].Payload.(*event.TaskCompletedPayload); p.Status != event.TaskStatusFailed {
		t.Errorf("Status = %q, want failed", p.Status)
	}
}

// A row titled only "subagent" tells the operator nothing about what was
// delegated, so the title falls back through the prompt.
func TestSubagentTitleFallsBackToThePrompt(t *testing.T) {
	title, role := subagentTitle(json.RawMessage(`{"prompt":"Check every handler for missing auth\nand report back"}`))
	if title != "Check every handler for missing auth" {
		t.Errorf("title = %q, want the prompt's first line", title)
	}
	if role != "" {
		t.Errorf("role = %q, want empty when none was named", role)
	}

	long := strings.Repeat("x", 200)
	title, _ = subagentTitle(json.RawMessage(`{"prompt":"` + long + `"}`))
	if len([]rune(title)) > 81 {
		t.Errorf("title of %d runes was not trimmed", len([]rune(title)))
	}
}

// Parent traffic must stay unattributed.
func TestOrdinaryPiToolsCarryNoAgentID(t *testing.T) {
	st := piState()
	evts := feed(t, st, `{"type":"tool_execution_start","toolCallId":"call-2","toolName":"bash","args":{"command":"ls"}}`)
	for _, e := range evts {
		if e.AgentID != "" {
			t.Fatalf("an ordinary tool was attributed to agent %q", e.AgentID)
		}
	}
}
