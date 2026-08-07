package orchestration

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

type stubAdapter struct{ ch chan event.Event }

func (a *stubAdapter) Kind() provider.Kind             { return "stub" }
func (a *stubAdapter) InstanceID() provider.InstanceID { return "stub:1" }
func (a *stubAdapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{}
}
func (a *stubAdapter) StartSession(context.Context, provider.SessionStartInput) (provider.Session, error) {
	return provider.Session{}, nil
}
func (a *stubAdapter) SendTurn(context.Context, provider.SendTurnInput) (provider.TurnStartResult, error) {
	return provider.TurnStartResult{}, nil
}
func (a *stubAdapter) InterruptTurn(context.Context, string, string) error { return nil }
func (a *stubAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *stubAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *stubAdapter) StopSession(context.Context, string) error { return nil }
func (a *stubAdapter) StopAll(context.Context) error             { return nil }
func (a *stubAdapter) HasSession(string) bool                    { return true }
func (a *stubAdapter) ListSessions() []provider.Session          { return nil }
func (a *stubAdapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *stubAdapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *stubAdapter) Events() <-chan event.Event { return a.ch }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

func TestIngestionTurnsDeltasIntoLoggedEvents(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	if _, err := e.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"stub:1"}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{
			ItemType: event.ItemAssistantMessage, Stream: event.StreamText,
			Text: "hello", Sequence: 1,
		},
	}

	waitFor(t, func() bool {
		for _, ev := range store.All() {
			if ev.Type == EvtThreadActivityAppended {
				return true
			}
		}
		return false
	})
}

// A dead session must cancel pending approvals, or the UI shows a ghost
// prompt that can never be answered.
//
// cancelled is guarded by mu because it is written from the Ingestion.Consume
// goroutine and read from the test goroutine's waitFor poll — the plan's
// original fixture left this unsynchronized, which -race correctly flags.
type recordingBroker struct {
	mu        sync.Mutex
	cancelled []string
}

func (b *recordingBroker) Resolve(string, event.Decision) error { return approval.ErrUnknownRequest }
func (b *recordingBroker) CancelThread(threadID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cancelled = append(b.cancelled, threadID)
}
func (b *recordingBroker) snapshot() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.cancelled...)
}

func TestSessionExitedCancelsPendingApprovals(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	if _, err := e.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"stub:1"}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	br := &recordingBroker{}
	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, br, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.SessionExited, ThreadID: "w-abc",
		Payload: &event.SessionExitedPayload{Reason: "exit"},
	}

	waitFor(t, func() bool {
		c := br.snapshot()
		return len(c) == 1 && c[0] == "w-abc"
	})

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.Status == ThreadStopped
	})
}

// A closed adapter channel means the process died; Consume must return rather
// than spin.
func TestConsumeReturnsWhenAdapterChannelCloses(t *testing.T) {
	store := NewMemStore()
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 4,
		NewID: func() string { return "ae-x" },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	a := &stubAdapter{ch: make(chan event.Event)}
	in := NewIngestion(e, approval.NoopBroker{}, func() string { return "ac-x" })

	done := make(chan struct{})
	go func() { in.Consume(ctx, a); close(done) }()
	close(a.ch)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Consume did not return after the adapter channel closed")
	}
}
