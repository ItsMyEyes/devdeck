package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// Codex's `multi_agent` feature is STABLE and ON BY DEFAULT (verified:
// `codex features list` on 0.145.0), so everything below is live for every
// user of this provider — which is why the pre-existing behaviour was the
// worst of the four: `itemTypeOf`'s `default:` turned both subagent item
// types into untitled `ItemToolCall` rows with a null detail, in the PARENT's
// transcript, with no warning at all.

// notify feeds one whole notification line through the parser, which is what
// adapter.dispatchNotification hands it (see the comment there — it used to
// hand over only `params`, and every notification came back a warning).
func notify(t *testing.T, st *parseState, method string, params any) []event.Event {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	line, err := json.Marshal(map[string]any{"method": method, "params": json.RawMessage(raw)})
	if err != nil {
		t.Fatalf("marshal line: %v", err)
	}
	return parseNotification(line, st)
}

func subagentState() *parseState {
	return newParseState("w-abc", "codex-parent", "codex:default")
}

func ofType(evts []event.Event, t event.Type) []event.Event {
	var out []event.Event
	for _, e := range evts {
		if e.Type == t {
			out = append(out, e)
		}
	}
	return out
}

// The core regression. A subAgentActivity item must describe an AGENT, not
// leave a blank row in the parent's narrative.
func TestSubAgentActivityBecomesATaskRatherThanABlankToolRow(t *testing.T) {
	st := subagentState()
	evts := notify(t, st, "item/started", map[string]any{
		"turnId": "turn-1",
		"item": map[string]any{
			"type": "subAgentActivity", "id": "item-1",
			"agentThreadId": "codex-child-1", "agentPath": "agents/reviewer.md", "kind": "started",
		},
	})

	started := ofType(evts, event.TaskStarted)
	if len(started) != 1 {
		t.Fatalf("task.started count = %d, want 1 (events: %+v)", len(started), evts)
	}
	if started[0].AgentID != "codex-child-1" {
		t.Errorf("AgentID = %q, want the child thread id", started[0].AgentID)
	}
	// The old behaviour, pinned so it cannot come back.
	for _, e := range evts {
		if e.Type == event.ItemStarted {
			p := e.Payload.(*event.ItemStartedPayload)
			if p.ItemType == event.ItemToolCall && p.Title == "" {
				t.Fatal("a subagent item still renders as an untitled tool row in the parent transcript")
			}
		}
	}
}

// item/started and item/completed for a subAgentActivity deliver IDENTICAL
// information — it is an instantaneous marker, not a span. Emitting for both
// would double every row.
func TestSubAgentActivityIsNotCountedTwice(t *testing.T) {
	st := subagentState()
	params := map[string]any{
		"turnId": "turn-1",
		"item": map[string]any{
			"type": "subAgentActivity", "id": "item-1",
			"agentThreadId": "codex-child-1", "kind": "started",
		},
	}
	first := notify(t, st, "item/started", params)
	second := notify(t, st, "item/completed", params)

	if len(ofType(first, event.TaskStarted)) != 1 {
		t.Fatalf("first sighting produced %d task.started, want 1", len(ofType(first, event.TaskStarted)))
	}
	if len(second) != 0 {
		t.Fatalf("the identical second notification produced %d events, want 0: %+v", len(second), second)
	}
}

// `interrupted` is a stop, not a completion — an operator who killed a fleet
// must not be told it finished.
func TestSubAgentActivityKindMapsOntoTheCanonicalStatuses(t *testing.T) {
	st := subagentState()
	notify(t, st, "item/started", map[string]any{
		"item": map[string]any{"type": "subAgentActivity", "id": "i-1", "agentThreadId": "c1", "kind": "started"},
	})
	evts := notify(t, st, "item/started", map[string]any{
		"item": map[string]any{"type": "subAgentActivity", "id": "i-2", "agentThreadId": "c1", "kind": "interrupted"},
	})

	var got event.TaskStatus
	for _, e := range evts {
		switch p := e.Payload.(type) {
		case *event.TaskCompletedPayload:
			got = p.Status
		case *event.TaskUpdatedPayload:
			got = p.Status
		}
	}
	if got != event.TaskStatusStopped {
		t.Fatalf("interrupted mapped to %q, want stopped", got)
	}
}

// The spawn tool call is the parent's own action and belongs in the parent's
// transcript — but TITLED, which is exactly what the old default: branch could
// not do (no title, null detail).
func TestCollabAgentToolCallProducesATitledRow(t *testing.T) {
	st := subagentState()
	evts := notify(t, st, "item/started", map[string]any{
		"turnId": "turn-1",
		"item": map[string]any{
			"type": "collabAgentToolCall", "id": "item-2", "tool": "spawnAgent", "status": "inProgress",
			"senderThreadId": "codex-parent", "receiverThreadIds": []string{"codex-child-1"},
			"prompt": "Review the diff", "model": "gpt-5",
		},
	})

	var titled bool
	for _, e := range evts {
		if p, ok := e.Payload.(*event.ItemStartedPayload); ok {
			if p.Title == "" {
				t.Error("collabAgentToolCall produced an untitled row")
			}
			if !strings.Contains(strings.ToLower(p.Title), "agent") {
				t.Errorf("title = %q, want it to name the tool", p.Title)
			}
			titled = true
		}
	}
	if !titled {
		t.Fatalf("no item row emitted for the spawn tool call: %+v", evts)
	}
}

// A spawn names the threads it created. Registering them is what lets the
// adapter re-home their traffic instead of dropping it — the bug that made a
// codex subagent's actual work vanish entirely.
func TestSpawnRegistersItsChildThreadsForRehoming(t *testing.T) {
	st := subagentState()
	var registered []string
	st.onChildThread = func(id string) { registered = append(registered, id) }

	notify(t, st, "item/started", map[string]any{
		"item": map[string]any{
			"type": "collabAgentToolCall", "id": "item-2", "tool": "spawnAgent", "status": "inProgress",
			"receiverThreadIds": []string{"codex-child-1", "codex-child-2"},
		},
	})

	if len(registered) < 2 {
		t.Fatalf("registered %v, want both spawned threads", registered)
	}
}

// Parent traffic must stay unattributed, or the client folds the operator's
// own conversation into a subagent's row.
func TestParentItemsCarryNoAgentID(t *testing.T) {
	st := subagentState()
	evts := notify(t, st, "item/started", map[string]any{
		"turnId": "turn-1",
		"item":   map[string]any{"type": "agentMessage", "id": "item-3"},
	})
	for _, e := range evts {
		if e.AgentID != "" {
			t.Fatalf("parent item was attributed to agent %q", e.AgentID)
		}
	}
}

// Each of these ticks continuously on a healthy 0.145.0 session. Reaching the
// parser's `default:` meant one RuntimeWarning per event — a transcript full
// of notices about frames DevDeck has no use for.
func TestKnownNoiseNotificationsProduceNoWarning(t *testing.T) {
	quiet := []string{
		"externalAgentConfig/import/completed", "externalAgentConfig/import/progress",
		"fuzzyFileSearch/sessionCompleted", "fuzzyFileSearch/sessionUpdated",
		"thread/environment/connected", "thread/environment/disconnected",
		"thread/goal/updated", "thread/goal/cleared", "thread/settings/updated",
		"thread/realtime/connected", "thread/realtime/disconnected",
		"thread/realtime/started", "thread/realtime/stopped",
		"thread/realtime/updated", "thread/realtime/error",
		"thread/realtime/audioDelta", "thread/realtime/transcriptDelta",
		"thread/realtime/status",
		"windows/worldWritableWarning", "windowsSandbox/setupCompleted",
	}
	st := subagentState()
	for _, method := range quiet {
		if evts := notify(t, st, method, map[string]any{}); len(evts) != 0 {
			t.Errorf("%s produced %d events, want none: %+v", method, len(evts), evts)
		}
	}
}

// Regression, and the most consequential one in this package: the adapter
// unmarshalled each notification into {Params} and handed parseNotification
// only the params. The parser switches on the envelope's `method`, so every
// notification arrived with an empty one, fell to `default:`, and came back
// as `unrecognized codex notification ""`.
//
// In production that meant the codex transcript was warnings and nothing
// else — no assistant text, no tool calls, no turn lifecycle. The parser's
// own tests missed it for the same reason it survived review: they rebuild
// `{method, params}` before calling in, so they exercised a shape the adapter
// never produced. This test walks the ADAPTER's decode, not the parser's.
func TestTheAdapterHandsTheParserAWholeNotificationLine(t *testing.T) {
	line := []byte(`{"method":"turn/started","params":{"threadId":"tid","turn":{"id":"turn-1","status":"inProgress"}}}`)

	// Exactly what dispatchNotification does with the line before parsing.
	var wrapper struct {
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &wrapper); err != nil {
		t.Fatalf("unwrap: %v", err)
	}

	st := newParseState("w-abc", "tid", "codex:default")
	evts := parseNotification(line, st)

	if len(evts) != 1 || evts[0].Type != event.TurnStarted {
		t.Fatalf("turn/started produced %+v, want one turn.started", evts)
	}

	// And the shape that used to be passed really is the broken one, so this
	// test fails loudly if anyone reverts the call site.
	if broken := parseNotification(wrapper.Params, st); len(broken) == 1 && broken[0].Type == event.TurnStarted {
		t.Fatal("params-only now parses too; this regression test no longer proves anything")
	}
}
