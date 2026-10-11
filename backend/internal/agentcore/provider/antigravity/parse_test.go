package antigravity

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// Captured by the parent against agy 1.3.3 in plan mode. IDs, paths, and
// the long tools list are sanitized; text/state/usage fields are unchanged.
func TestLivePlanFixture(t *testing.T) {
	f, err := os.Open("testdata/live-plan.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st := newParseState("test", "thread", "turn", cursor{})
	scanner := bufio.NewScanner(f)
	var text string
	var sequences []uint64
	var starts, ends int
	for scanner.Scan() {
		events, err := st.parse(scanner.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range events {
			switch e.Type {
			case event.ContentDelta:
				p := e.Payload.(*event.ContentDeltaPayload)
				text += p.Text
				sequences = append(sequences, p.Sequence)
			case event.ItemStarted:
				starts++
			case event.ItemCompleted:
				ends++
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if text != "DEVDECK_ANTIGRAVITY_OK\n" || starts != 1 || ends != 1 || len(sequences) != 3 || sequences[2] != 3 {
		t.Fatalf("text/lifecycle mismatch: %q %d/%d %v", text, starts, ends, sequences)
	}
	if st.status != "completed" || st.turnUsage.InputTokens != 12688 || st.turnUsage.OutputTokens != 173 || st.resume.ConversationID != "fixture-conversation" {
		t.Fatalf("result state: %+v", st)
	}
}

func parseFixture(t *testing.T, st *parseState, raw string) []event.Event {
	t.Helper()
	events, err := st.parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return events
}
func TestToolsAndSubagentMetadata(t *testing.T) {
	st := newParseState("test", "thread", "turn", cursor{})
	parseFixture(t, st, `{"event":"init","conversation_id":"parent","init":{}}`)
	start := parseFixture(t, st, `{"event":"step_update","step_update":{"conversation_id":"parent","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello"}}}}`)
	if len(start) != 1 || start[0].Payload.(*event.ItemStartedPayload).Title != "run_command" || !strings.Contains(string(start[0].Payload.(*event.ItemStartedPayload).Detail), "echo hello") {
		t.Fatalf("tool start: %+v", start)
	}
	end := parseFixture(t, st, `{"event":"step_update","step_update":{"conversation_id":"parent","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"hello\r\n"}}}`)
	if len(end) != 1 || end[0].ItemID != start[0].ItemID || end[0].Payload.(*event.ItemCompletedPayload).Status != "completed" {
		t.Fatalf("tool end: %+v", end)
	}
	failed := parseFixture(t, st, `{"event":"step_update","step_update":{"conversation_id":"parent","step_index":5,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","error":{"type":"permission_denied","message":"denied"}}}}`)
	if failed[1].Payload.(*event.ItemCompletedPayload).Status != "failed" {
		t.Fatal("tool failure lost")
	}
	agents := parseFixture(t, st, `{"event":"step_update","step_update":{"conversation_id":"parent","step_index":6,"state":"DONE","step_type":"tool","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"type_name":"explore","role":"research","conversation_id":"child-1","log_uri":"/native/log","workspace_uris":["/native/workspace"]},{"type_name":"review","role":"reviewer","conversation_id":"child-2"}]}}}`)
	if len(agents) != 3 || agents[0].Type != event.ItemStarted || agents[1].Type != event.ItemCompleted || agents[2].Type != event.RuntimeWarning {
		t.Fatalf("subagent events: %+v", agents)
	}
	for _, e := range agents {
		if e.ThreadID != "thread" || e.TurnID != "turn" {
			t.Fatalf("missing attribution: %+v", e)
		}
		if e.Type == event.TaskStarted || e.Type == event.TaskProgress || e.Type == event.TaskCompleted {
			t.Fatal("invented child lifecycle")
		}
	}
	if detail := string(agents[1].Payload.(*event.ItemCompletedPayload).Detail); !strings.Contains(detail, "child-1") || !strings.Contains(detail, "research") {
		t.Fatal("lost native subagent metadata", detail)
	}
	duplicate := parseFixture(t, st, `{"event":"step_update","step_update":{"conversation_id":"parent","step_index":6,"state":"DONE","step_type":"tool","tool_name":"invoke_subagent","subagent_info":{"subagents":[]}}}`)
	if len(duplicate) != 0 {
		t.Fatal("duplicate tool or warning", duplicate)
	}
	if end := st.finishItems("failed"); len(end) != 0 {
		t.Fatalf("completed tool got duplicate end: %+v", end)
	}
}

func TestResultFallbackUsageAndInvalidOutput(t *testing.T) {
	st := newParseState("test", "thread", "turn", cursor{ConversationID: "parent"})
	parseFixture(t, st, `{"event":"init","conversation_id":"parent","init":{}}`)
	parseFixture(t, st, `{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"checkpoint","usage":{"input_tokens":5,"output_tokens":2,"cache_read_tokens":4}}}`)
	events := parseFixture(t, st, `{"event":"result","result":{"conversation_id":"parent","status":"SUCCESS","response":"fallback","usage":{"input_tokens":500,"output_tokens":200,"cache_read_tokens":400}}}`)
	var text string
	for _, e := range events {
		if e.Type == event.ContentDelta {
			text += e.Payload.(*event.ContentDeltaPayload).Text
		}
	}
	if text != "fallback" || st.turnUsage.InputTokens != 5 || st.turnUsage.OutputTokens != 2 || st.turnUsage.CacheReadTokens != 4 {
		t.Fatalf("ID-only resume cost/fallback: %+v %s", st.turnUsage, text)
	}
	if _, err := st.parse([]byte(`{"event":"result","result":{"status":"SUCCESS"}}`)); err == nil {
		t.Fatal("duplicate result accepted")
	}
	for _, raw := range []string{
		`not JSON`, `{}`, `{"event":"result"}`, `{"event":"init","init":{}}`,
		`{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"tool"}}`,
		`{"event":"result","result":{"status":"FUTURE"}}`,
		`{"event":"result","result":{"status":"SUCCESS"}}`,
		`{"event":"result","result":{"status":"ERROR","structured_output":{}}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			st := newParseState("test", "thread", "turn", cursor{})
			if _, err := st.parse([]byte(raw)); err == nil {
				t.Fatal("invalid stream accepted")
			}
		})
	}
	st = newParseState("test", "thread", "turn", cursor{ConversationID: "parent"})
	if _, err := st.parse([]byte(`{"event":"init","conversation_id":"other","init":{}}`)); err == nil {
		t.Fatal("conversation switched")
	}
}

func TestArgsPermissionsPlanAndOptions(t *testing.T) {
	for _, mode := range []provider.RuntimeMode{provider.ModeAuto, provider.ModeFullAccess} {
		for _, interact := range []provider.InteractionMode{provider.InteractionDefault, provider.InteractionPlan} {
			in := provider.SendTurnInput{Text: "prompt", Mode: mode, Interact: interact, Model: provider.ModelSelection{Model: "model", Options: map[string]any{"effort": "xhigh"}}}
			if err := validate(mode, interact, in.Model); err != nil {
				t.Fatal(err)
			}
			args := strings.Join(buildArgs(in, cursor{ConversationID: "own"}), " ")
			if strings.Contains(args, "--continue") || !strings.Contains(args, "--conversation own") || !strings.Contains(args, "--model model --effort xhigh") {
				t.Fatal(args)
			}
			if !strings.Contains(args, "--print-timeout 0") {
				t.Fatal("turn generation must not have an arbitrary timeout", args)
			}
			if strings.Contains(args, "--dangerously-skip-permissions") != (mode == provider.ModeFullAccess) {
				t.Fatal("permission mapping", args)
			}
			if strings.Contains(args, "--mode plan") != (interact == provider.InteractionPlan) {
				t.Fatal("plan mapping", args)
			}
		}
	}
	for _, effort := range []string{"low", "medium", "high", "xhigh", "max"} {
		if err := validate(provider.ModeAuto, provider.InteractionDefault, provider.ModelSelection{Options: map[string]any{"effort": effort}}); err != nil {
			t.Fatal(err)
		}
	}
	var decoded cursor
	data, _ := json.Marshal(cursor{ConversationID: "own", Usage: &wireUsage{Input: 4}})
	if json.Unmarshal(data, &decoded) != nil || decoded.Usage.Input != 4 {
		t.Fatal("cursor usage not persisted")
	}
}
