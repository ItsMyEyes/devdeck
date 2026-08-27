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

// A process restart destroys every in-flight agent turn along with the PTYs,
// so "is it safe to restart?" has to count turns too — see decision D3 of
// docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md. Running (a
// turn is in flight) and waiting (a turn is blocked on the operator) both lose
// work; idle and stopped do not.
func TestBusyThreadCountCountsRunningAndWaitingOnly(t *testing.T) {
	initial := NewState()
	initial.Threads = map[string]*Thread{
		"w-run":     {ID: "w-run", Status: ThreadRunning},
		"w-wait":    {ID: "w-wait", Status: ThreadWaiting},
		"w-idle":    {ID: "w-idle", Status: ThreadIdle},
		"w-stopped": {ID: "w-stopped", Status: ThreadStopped},
		// Skipped even though its last status still reads running: a deleted
		// thread has nothing left for a restart to lose.
		"w-deleted": {ID: "w-deleted", Status: ThreadRunning, Deleted: true},
	}
	e := NewEngine(EngineOptions{Store: NewMemStore(), Initial: initial})

	if got := e.BusyThreadCount(); got != 2 {
		t.Errorf("BusyThreadCount() = %d, want 2 (one running + one waiting)", got)
	}
}

func TestBusyThreadCountIsZeroForAnEmptyState(t *testing.T) {
	e := NewEngine(EngineOptions{Store: NewMemStore(), Initial: NewState()})
	if got := e.BusyThreadCount(); got != 0 {
		t.Errorf("BusyThreadCount() = %d, want 0 for a state with no threads", got)
	}
}

// The busy endpoint is constructed with whatever engine main.go has at that
// point — possibly none. A nil engine reports zero instead of panicking,
// mirroring terminal.ActiveSessionCount()'s nil-registry guard.
func TestBusyThreadCountIsZeroForANilEngine(t *testing.T) {
	var e *Engine
	if got := e.BusyThreadCount(); got != 0 {
		t.Errorf("BusyThreadCount() = %d, want 0 for a nil engine", got)
	}
}

// The table-driven cases above pin the rule; this one pins it to the statuses
// real commands actually produce, so a rename in the projector can't leave the
// count silently reading a status nothing sets any more.
func TestBusyThreadCountSeesALiveTurn(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	if got := e.BusyThreadCount(); got != 0 {
		t.Fatalf("BusyThreadCount() after create = %d, want 0 (idle)", got)
	}
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}
	if got := e.BusyThreadCount(); got != 1 {
		t.Errorf("BusyThreadCount() during a turn = %d, want 1", got)
	}
}
