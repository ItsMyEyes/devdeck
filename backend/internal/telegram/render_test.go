package telegram

import (
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestRenderUserMessage(t *testing.T) {
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadMessageSent,
		Payload: mustJSON(t, map[string]any{"text": "restart api <b>now</b>"}),
	})
	if got.Card != nil {
		t.Fatalf("a user message is not a card")
	}
	// The echo is kept OUT of Notices so the pump can drop it for a turn this
	// bridge itself started — see Rendered.Echo. The "working on it" notice
	// always survives; it is the chat's only sign of life before the first
	// token arrives.
	if !strings.Contains(got.Echo, "restart api") {
		t.Fatalf("prompt echo missing: %q", got.Echo)
	}
	if len(got.Notices) != 1 || !strings.Contains(got.Notices[0], "memproses") {
		t.Fatalf("want exactly the loading notice, got %+v", got.Notices)
	}
	if got.Text != "" {
		t.Fatalf("a user message must not buffer as assistant prose: %q", got.Text)
	}
}

func TestRenderAssistantDeltaAndReasoningAreDistinguished(t *testing.T) {
	text := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, map[string]any{"itemId": "i1", "stream": string(event.StreamText), "text": "sudah aktif", "sequence": 1}),
	})
	if text.Text == "" || text.Card != nil {
		t.Fatalf("assistant delta should buffer text, got %+v", text)
	}
	// Buffered RAW, not converted: the pump concatenates deltas and converts
	// the whole block once, because a "**bold**" split across two deltas can
	// only be escaped correctly after both halves have arrived.
	if text.Text != "sudah aktif" {
		t.Fatalf("delta text was transformed before buffering: %q", text.Text)
	}
	reason := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, map[string]any{"itemId": "i2", "stream": string(event.StreamReasoning), "text": "perlu cek dulu", "sequence": 1}),
	})
	if reason.Text != "" || reason.Reasoning == "" {
		t.Fatalf("reasoning must buffer separately from the answer, got %+v", reason)
	}
}

// NOTE: the plan's draft of this test guessed a `ToolName` field on
// event.RequestOpenedPayload. The real struct (event/event.go) has no such
// field — it carries RequestType, Detail, Args and Options instead. Fixed
// here to use the real names; the test's intent (an opened request with
// three decisions becomes a card with three buttons) is unchanged.
func TestRenderApprovalRequestBecomesACardWithThreeDecisions(t *testing.T) {
	inner := event.Event{
		Type:      event.RequestOpened,
		RequestID: "req-1",
		Payload: &event.RequestOpenedPayload{
			RequestType: event.ReqCommandExecApproval,
			Detail:      "Bash: restart nginx",
			Options:     []event.Decision{event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline},
		},
	}
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, inner),
	})
	if got.Card == nil {
		t.Fatalf("an opened request must render as a card, got %+v", got)
	}
	if got.Card.RequestID != "req-1" {
		t.Fatalf("card lost the requestId: %+v", got.Card)
	}
	if len(got.Card.Buttons) != 3 {
		t.Fatalf("want 3 decision buttons, got %d", len(got.Card.Buttons))
	}
}

func TestRenderTurnCompletedEndsTheTurn(t *testing.T) {
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, event.Event{Type: event.TurnCompleted}),
	})
	if !got.EndTurn {
		t.Fatalf("TurnCompleted must end the turn so buffered prose is flushed")
	}
}

func TestRenderIgnoresBookkeeping(t *testing.T) {
	got := Render(orchestration.Event{Type: orchestration.EvtThreadSessionSet, Payload: mustJSON(t, map[string]any{"status": "running"})})
	if got.Text != "" || got.Card != nil || len(got.Notices) != 0 {
		t.Fatalf("session bookkeeping must render nothing, got %+v", got)
	}
}

// A reactor failure — "the CLI binary is missing", "this SSH connection id
// does not exist", "the session would not start" — reaches the thread as
// {"kind":"runtime.error","message":…} (workers.go's Reactor.reportError).
// It carries no "type" field, so decodeForwardedEvent rejects it, and before
// this it rendered as nothing at all: the operator's prompt produced silence
// and the thread quietly went idle.
func TestRenderReactorErrorIsVisibleAndEndsTheTurn(t *testing.T) {
	got := Render(orchestration.Event{
		Type: orchestration.EvtThreadActivityAppended,
		Payload: mustJSON(t, map[string]any{
			"kind":    "runtime.error",
			"message": "agent thread ssh:c-typo: ssh connection not found",
		}),
	})
	if len(got.Notices) == 0 {
		t.Fatal("a reactor error rendered as nothing — the operator gets silence")
	}
	if !strings.Contains(got.Notices[0], "ssh connection not found") {
		t.Fatalf("the cause is missing from the rendered notice: %q", got.Notices[0])
	}
	// reportError settles the thread to idle, so no TurnCompleted follows to
	// flush whatever prose was buffered.
	if !got.EndTurn {
		t.Fatal("a reactor error must end the turn; nothing else will")
	}
}
