package orchestration

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// TestReactorRecallsMemoryAndPrependsToSendTurn proves the seam this feature
// depends on: whatever Reactor.Memory.Recall returns must reach the provider
// call, prepended to the user's own text — not replacing it, not dropped.
func TestReactorRecallsMemoryAndPrependsToSendTurn(t *testing.T) {
	rec := &callRecorder{}
	adapter := &fakeAdapter{rec: rec, ch: make(chan event.Event, 4)}
	registry := provider.NewRegistry(&fakeDriver{rec: rec, adapter: adapter})
	dir := &recordingDir{rec: rec, inner: NewThreadDirectory()}
	svc := &provider.Service{Registry: registry, Dir: dir}

	store := NewMemStore()
	engine := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { return "ae-1" },
	})

	var mu sync.Mutex
	var gotThreadID, gotQuery string
	reactor := &Reactor{
		Engine: engine, Provider: svc, Broker: approval.NoopBroker{},
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			return "fake:default", provider.SessionStartInput{ThreadID: threadID, Cwd: "/tmp/w-abc"}, nil
		},
		Memory: MemoryHooks{
			Recall: func(_ context.Context, threadID, query string) string {
				mu.Lock()
				gotThreadID, gotQuery = threadID, query
				mu.Unlock()
				return "<memories>user prefers dark mode</memories>"
			},
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	reactor.Start(ctx)

	if _, err := engine.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	waitFor(t, func() bool {
		for _, c := range rec.snapshot() {
			if c == "StartSession" {
				return true
			}
		}
		return false
	})

	if _, err := engine.Dispatch(ctx, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "what theme do I use?"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}

	waitFor(t, func() bool { return len(adapter.turnCalls()) == 1 })
	calls := adapter.turnCalls()

	mu.Lock()
	defer mu.Unlock()
	if gotThreadID != "w-abc" || gotQuery != "what theme do I use?" {
		t.Fatalf("Recall called with (%q, %q), want (w-abc, original user text)", gotThreadID, gotQuery)
	}
	if !strings.Contains(calls[0].Text, "user prefers dark mode") {
		t.Fatalf("SendTurn text = %q, missing recalled block", calls[0].Text)
	}
	if !strings.Contains(calls[0].Text, "what theme do I use?") {
		t.Fatalf("SendTurn text = %q, lost the user's own message", calls[0].Text)
	}
}

// TestReactorSkipsPrependWhenRecallReturnsEmpty proves a disabled/empty
// recall leaves the turn's text completely untouched — no stray block, no
// extra newlines, for the common case where memory has nothing to say.
func TestReactorSkipsPrependWhenRecallReturnsEmpty(t *testing.T) {
	rec := &callRecorder{}
	adapter := &fakeAdapter{rec: rec, ch: make(chan event.Event, 4)}
	registry := provider.NewRegistry(&fakeDriver{rec: rec, adapter: adapter})
	dir := &recordingDir{rec: rec, inner: NewThreadDirectory()}
	svc := &provider.Service{Registry: registry, Dir: dir}

	store := NewMemStore()
	engine := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { return "ae-1" },
	})

	reactor := &Reactor{
		Engine: engine, Provider: svc, Broker: approval.NoopBroker{},
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			return "fake:default", provider.SessionStartInput{ThreadID: threadID, Cwd: "/tmp/w-abc"}, nil
		},
		Memory: MemoryHooks{
			Recall: func(context.Context, string, string) string { return "" },
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	reactor.Start(ctx)

	if _, err := engine.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc", Payload: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	waitFor(t, func() bool {
		for _, c := range rec.snapshot() {
			if c == "StartSession" {
				return true
			}
		}
		return false
	})

	if _, err := engine.Dispatch(ctx, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}

	waitFor(t, func() bool { return len(adapter.turnCalls()) == 1 })
	if got := adapter.turnCalls()[0].Text; got != "hello" {
		t.Fatalf("SendTurn text = %q, want unmodified %q", got, "hello")
	}
}

// TestIngestionRetainsAssistantTextOnTurnCompleted proves the assistant's
// full reply — accumulated across every ContentDelta of the turn — reaches
// Retain exactly once, tagged "assistant", when the turn completes.
func TestIngestionRetainsAssistantTextOnTurnCompleted(t *testing.T) {
	store := NewMemStore()
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { return "ae-1" },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")

	var mu sync.Mutex
	var calls []struct{ threadID, role, text string }
	in := NewIngestion(e, approval.NoopBroker{}, func() string { return "ac-in-1" })
	in.Memory = MemoryHooks{
		Retain: func(_ context.Context, threadID, role, text string) {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, struct{ threadID, role, text string }{threadID, role, text})
		},
	}

	a := &stubAdapter{ch: make(chan event.Event, 8)}
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{ItemType: event.ItemAssistantMessage, Stream: event.StreamText, Text: "The theme is ", Sequence: 1},
	}
	a.ch <- event.Event{
		Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{ItemType: event.ItemAssistantMessage, Stream: event.StreamText, Text: "dark mode.", Sequence: 2},
	}
	a.ch <- event.Event{
		Type: event.TurnCompleted, ThreadID: "w-abc",
		Payload: &event.TurnCompletedPayload{Status: "completed"},
	}

	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(calls) == 1
	})

	mu.Lock()
	defer mu.Unlock()
	if calls[0].threadID != "w-abc" || calls[0].role != "assistant" {
		t.Fatalf("call = %+v, want threadID=w-abc role=assistant", calls[0])
	}
	if calls[0].text != "The theme is dark mode." {
		t.Fatalf("retained text = %q, want accumulated delta text", calls[0].text)
	}
}

// TestIngestionRetainSkippedWithNoHookConfigured proves the zero-value
// MemoryHooks stays a true no-op: nothing panics, nothing blocks, when a
// turn completes and Retain was never set — this is every pre-existing
// Ingestion in this package's test suite.
func TestIngestionRetainSkippedWithNoHookConfigured(t *testing.T) {
	store := NewMemStore()
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { return "ae-1" },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")

	in := NewIngestion(e, approval.NoopBroker{}, func() string { return "ac-in-1" })
	a := &stubAdapter{ch: make(chan event.Event, 4)}
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.TurnCompleted, ThreadID: "w-abc",
		Payload: &event.TurnCompletedPayload{Status: "completed"},
	}

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.Status == ThreadIdle
	})
}
