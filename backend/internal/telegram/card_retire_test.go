package telegram

import (
	"context"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// ---------------------------------------------------------------------------
// Spent cards must not pile up
// ---------------------------------------------------------------------------
//
// A busy agent asks for approval constantly, and the operator usually answers
// in the desktop app rather than in Telegram. Every one of those requests used
// to leave its card behind in the chat — full text, four live-looking buttons,
// forever — so the mirror of a single session became a wall of dead cards.
// Worse, the buttons still resolved: tapping one dispatched an answer to a
// request that no longer existed.

// answerInTheApp is what the desktop app's approval button does, reduced to
// the one command it dispatches. Deliberately NOT routed through the bridge:
// the whole point is that this decision happens somewhere the bridge never
// sees, and the card still has to go.
func answerInTheApp(t *testing.T, engine *orchestration.Engine, threadID, requestID string, d event.Decision) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "app-approve-" + requestID,
		Type:      orchestration.CmdThreadApprovalRespond,
		ThreadID:  threadID,
		Payload: mustJSON(t, orchestration.ApprovalRespondPayload{
			RequestID: requestID, Decision: d,
		}),
	}); err != nil {
		t.Fatalf("approve in app: %v", err)
	}
}

func TestApprovingInTheAppRemovesTheTelegramCard(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1",
		[]event.Decision{event.DecisionAccept, event.DecisionDecline})

	b.sweep(context.Background())
	if len(transport.sent) != 1 || len(transport.sent[0].Keyboard) == 0 {
		t.Fatalf("expected exactly one approval card, got %+v", transport.sent)
	}
	cardMessageID := int64(1) // fakeTransport hands out ids from 1

	answerInTheApp(t, engine, "w-abc", "req-1", event.DecisionAccept)
	b.sweep(context.Background())

	if len(transport.deletes) != 1 {
		t.Fatalf("the card was not retired: deletes=%+v", transport.deletes)
	}
	if got := transport.deletes[0]; got.ChatID != 100 || got.MessageID != cardMessageID {
		t.Fatalf("retired the wrong message: %+v, want chat 100 message %d", got, cardMessageID)
	}
}

// Retiring a card must also retire the WHOLE keyboard's tokens, not just the
// one button that happened to be tapped. Four buttons means four capabilities
// to answer a request that is already decided; leaving three of them live for
// the full 24h TTL is how a stale tap reaches the decider at all.
func TestRetiringACardInvalidatesEveryButtonOnIt(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1",
		[]event.Decision{event.DecisionAccept, event.DecisionDecline, event.DecisionCancel})

	b.sweep(context.Background())
	if len(transport.sent) != 1 {
		t.Fatalf("expected exactly one approval card, got %+v", transport.sent)
	}
	var tokens []string
	for _, row := range transport.sent[0].Keyboard {
		for _, btn := range row {
			tokens = append(tokens, btn.CallbackData)
		}
	}
	if len(tokens) != 3 {
		t.Fatalf("want 3 buttons, got %d", len(tokens))
	}

	answerInTheApp(t, engine, "w-abc", "req-1", event.DecisionAccept)
	b.sweep(context.Background())

	for _, token := range tokens {
		if _, ok := b.resolveCallback(token); ok {
			t.Fatalf("token %q still resolves after the request was decided elsewhere", token)
		}
	}
}

// A card too old for Telegram's 48h delete window still has to stop offering
// an answer. Deleting is the intent; stripping the buttons is the floor.
func TestACardTooOldToDeleteHasItsButtonsStrippedInstead(t *testing.T) {
	transport := &fakeTransport{
		deleteErr: &APIError{Code: 400, Desc: "Bad Request: message can't be deleted"},
	}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept})

	b.sweep(context.Background())
	answerInTheApp(t, engine, "w-abc", "req-1", event.DecisionAccept)
	b.sweep(context.Background())

	if len(transport.edits) == 0 {
		t.Fatalf("delete failed and nothing edited the card — its buttons are still live")
	}
	last := transport.edits[len(transport.edits)-1]
	if last.MessageID != 1 || last.ChatID != 100 {
		t.Fatalf("fallback edit hit the wrong message: %+v", last)
	}
}

// An ordinary transcript event must not be mistaken for a resolution. The
// retire path keys off specific event types; a false positive would delete a
// card that is still waiting for an answer.
func TestUnrelatedEventsDoNotRetireALiveCard(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept})
	b.sweep(context.Background())

	// Some unrelated activity on the same thread while the card is still open.
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "noise-1", Type: orchestration.CmdThreadActivityAppend, ThreadID: "w-abc",
		Payload: mustJSON(t, event.Event{
			Type: event.ItemCompleted, ThreadID: "w-abc",
			Payload: &event.ItemCompletedPayload{ItemType: event.ItemToolCall},
		}),
	}); err != nil {
		t.Fatalf("append activity: %v", err)
	}
	b.sweep(context.Background())

	if len(transport.deletes) != 0 {
		t.Fatalf("a live card was retired by unrelated activity: %+v", transport.deletes)
	}
}
