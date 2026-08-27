package telegram

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// ---------------------------------------------------------------------------
// The tapped button that only ever spins
// ---------------------------------------------------------------------------
//
// Observed in production, 2026-08-27: four approval buttons ("✅ Terima",
// "❌ Tolak", "🚫 Batalkan", "✅ Terima (sesi ini)") showed Telegram's
// progress spinner and never resolved. The bridge's own log carried the whole
// story:
//
//	11:05:29  telegram: approval respond thread ssh:sc-…: request … is not pending
//	          [53 seconds, nothing at all]
//	11:06:22  telegram: answer callback …: 400 Bad Request: query is too old and
//	          response timeout expired or query ID is invalid
//	11:06:23  telegram: answer callback …: 400 Bad Request: query is too old …
//	11:06:23  telegram: answer callback …: 400 Bad Request: query is too old …
//
// Telegram keeps the spinner up until answerCallbackQuery arrives and kills
// the query a few seconds after the tap. Every one of those answers was sent
// after the deadline, so every button kept spinning. The tests below pin the
// three things that made the answers late.

// A tap must be answered before the bridge dispatches anything to the engine.
//
// Engine.Dispatch is a round trip through one serialized command queue, waited
// on with the bridge's process-lifetime context — there is no bound on how
// long it can take when the engine is busy. Answering afterwards puts an
// unbounded wait in front of a deadline measured in seconds.
func TestTheTapIsAnsweredBeforeTheEngineIsDispatchedTo(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept})
	b.sweep(context.Background())
	if len(transport.sent) != 1 || len(transport.sent[0].Keyboard) == 0 {
		t.Fatalf("expected exactly one approval card, got %+v", transport.sent)
	}
	token := transport.sent[0].Keyboard[0][0].CallbackData
	mustAllow(t, st, 42)

	// Observe the world at the instant the spinner is cleared.
	var approvalCommittedBeforeAnswer bool
	transport.onAnswer = func() {
		evts, err := st.AgentEventsSince("w-abc", 0)
		if err != nil {
			return
		}
		for _, e := range evts {
			if e.Type == orchestration.EvtThreadApprovalResponseRequested {
				approvalCommittedBeforeAnswer = true
			}
		}
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-1", From: &User{ID: 42}, Data: token,
		Message: &Message{MessageID: 55, Chat: Chat{ID: 100}},
	}})

	if len(transport.answers) == 0 {
		t.Fatalf("the tap was never answered at all")
	}
	if approvalCommittedBeforeAnswer {
		t.Fatalf("the spinner was cleared only AFTER the engine had committed the approval — " +
			"a busy engine therefore holds the button spinning past Telegram's deadline")
	}
	// And the decision must still land: answering early must not skip the work.
	evts, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var dispatched bool
	for _, e := range evts {
		if e.Type == orchestration.EvtThreadApprovalResponseRequested {
			dispatched = true
		}
	}
	if !dispatched {
		t.Fatalf("answering the tap early swallowed the approval — no response event committed")
	}
}

// Answering a tap must never sit in callWithRetry's rate-limit sleep.
//
// This is the 53-second gap. callWithRetry's contract — "never drop what was
// about to be sent" — is right for transcript content and wrong for a callback
// answer: retry_after is tens of seconds, Telegram has already invalidated the
// query by then, so the sleep cannot help and can only hold the goroutine.
func TestAnsweringATapNeverParksOnARateLimit(t *testing.T) {
	transport := &fakeTransport{
		answerErr: &APIError{Code: 429, Desc: "Too Many Requests", RetryAfter: 45 * time.Second},
	}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	done := make(chan struct{})
	go func() {
		defer close(done)
		// An unknown token: the shortest path to answerCallback, with no
		// dispatch in the way, so this measures the answer alone.
		b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
			ID: "cbq-1", From: &User{ID: 42}, Data: "cb:deadbeef",
			Message: &Message{MessageID: 55, Chat: Chat{ID: 100}},
		}})
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("answering a rate-limited callback parked the caller — " +
			"it must fail fast, because the query is dead long before retry_after elapses")
	}
}

// One slow tap must not spend the deadline of the taps behind it.
//
// This is the other half of the 53 seconds. Every inbound update used to be
// handled in line on the single poll goroutine, so the three taps that arrived
// while the first one was stuck could not even reach Telegram until it
// finished — by which time all of them had expired. The log shows exactly
// that: three "query is too old" answers within one second of each other,
// almost a minute after the taps.
//
// Driven through pollLoop rather than handleUpdate, because the poll loop is
// where the ordering decision lives.
func TestOneStuckTapDoesNotHoldUpTheTapsBehindIt(t *testing.T) {
	const taps = 3
	arrived := make(chan struct{}, taps)
	release := make(chan struct{})

	transport := &callbackBatchTransport{}
	transport.onAnswer = func() {
		arrived <- struct{}{}
		<-release // every tap stays parked until the test lets them all go
	}
	for i := 0; i < taps; i++ {
		transport.batch = append(transport.batch, Update{
			UpdateID: int64(i + 1),
			CallbackQuery: &CallbackQuery{
				ID: "cbq-" + strconv.Itoa(i), From: &User{ID: 42}, Data: "cb:deadbeef",
				Message: &Message{MessageID: 55, Chat: Chat{ID: 100}},
			},
		})
	}

	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.pollLoop(ctx)

	// All three must be in flight AT ONCE. Serialized, only the first ever
	// arrives, and this times out.
	for i := 0; i < taps; i++ {
		select {
		case <-arrived:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatalf("only %d of %d taps reached Telegram while the first was stuck — "+
				"they are still serialized, so a slow tap expires every tap behind it", i, taps)
		}
	}
	close(release)
}

// callbackBatchTransport hands pollLoop one batch of callback updates and then
// blocks like a real long poll, so the loop is exercised end to end.
type callbackBatchTransport struct {
	fakeTransport
	batch    []Update
	deliverN int
	batchMu  sync.Mutex
}

func (f *callbackBatchTransport) GetUpdates(ctx context.Context, _ int64, _ int) ([]Update, error) {
	f.batchMu.Lock()
	first := f.deliverN == 0
	f.deliverN++
	f.batchMu.Unlock()
	if first {
		return f.batch, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}
