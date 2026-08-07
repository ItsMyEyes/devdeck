package orchestration

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func newTestEngine(t *testing.T) (*Engine, *MemStore, context.CancelFunc) {
	t.Helper()
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store:     store,
		NewID:     func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:       func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	return e, store, cancel
}

func dispatchCreate(t *testing.T, e *Engine, id string) {
	t.Helper()
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-create-" + id, Type: CmdThreadCreate, ThreadID: id,
		Payload: mustRaw(t, map[string]any{"instanceId": "claude:default"}),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
}

func TestEngineLifecycle(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}

	th, ok := e.State().Thread("w-abc")
	if !ok || th.Status != ThreadRunning {
		t.Fatalf("thread = %+v, want running", th)
	}
	if got := len(store.All()); got != 3 {
		t.Fatalf("log length = %d, want 3 (created, message-sent, turn-start-requested)", got)
	}
	// Seq must be assigned by the store, monotonically.
	for i, ev := range store.All() {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("event %d has Seq %d, want %d", i, ev.Seq, i+1)
		}
	}
}

// A reconnecting client resends the same CommandID. It must get the original
// events back, not a second turn.
func TestEngineIdempotency(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	cmd := Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}

	first, err := e.Dispatch(context.Background(), cmd)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := e.Dispatch(context.Background(), cmd)
	if err != nil {
		t.Fatalf("resend must not error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("resend produced different events:\n first=%+v\nsecond=%+v", first, second)
	}
	if got := len(store.All()); got != 3 {
		t.Fatalf("log length = %d, want 3 — resend must not append", got)
	}
}

func TestEngineRequiresCommandID(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	if _, err := e.Dispatch(context.Background(), Command{Type: CmdThreadCreate, ThreadID: "w-abc"}); err == nil {
		t.Fatal("missing CommandID must error")
	}
}

// The ordering invariant: a failed commit must leave the in-memory read model
// untouched. If this regresses, state silently diverges from the log.
func TestFailedCommitDoesNotSwapState(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	before, _ := e.State().Thread("w-abc")
	beforeStatus := before.Status

	store.FailCommit = errors.New("disk on fire")
	_, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	})
	if err == nil {
		t.Fatal("commit failure must surface as an error")
	}

	after, _ := e.State().Thread("w-abc")
	if after.Status != beforeStatus {
		t.Fatalf("status changed to %s after failed commit, want %s", after.Status, beforeStatus)
	}
}

// The regression guard for the entire event-sourcing contract. It must keep
// passing after Task 6 swaps MemStore for SQLite.
func TestReplayDeterministic(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-mode", Type: CmdThreadRuntimeModeSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"mode": "auto"}),
	}); err != nil {
		t.Fatalf("mode: %v", err)
	}

	replayed := Apply(NewState(), store.All())

	live := e.State()
	if !reflect.DeepEqual(live.Threads, replayed.Threads) {
		t.Fatalf("replay diverged:\n live=%+v\nreplay=%+v", live.Threads["w-abc"], replayed.Threads["w-abc"])
	}
}

func TestSubscribeReceivesCommittedEvents(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()

	sub, unsub := e.Subscribe(16)
	defer unsub()

	dispatchCreate(t, e, "w-abc")

	batch, ok := <-sub
	if !ok || len(batch) == 0 {
		t.Fatal("subscriber received nothing")
	}
	if batch[0].Type != EvtThreadCreated {
		t.Fatalf("first event = %s, want thread.created", batch[0].Type)
	}
	if batch[0].Seq == 0 {
		t.Fatal("published events must carry the committed Seq")
	}
}
