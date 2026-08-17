package orchestration

import (
	"context"
	"encoding/json"
	"strings"
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
func (a *stubAdapter) SetInteractionMode(context.Context, string, provider.InteractionMode) error {
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
	// Bounds a hang, nothing more — a healthy condition is met in
	// milliseconds. Generous on purpose so a failure here reads as "the thing
	// never happened" rather than "the machine was busy".
	deadline := time.Now().Add(10 * time.Second)
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

// The composer's context-window indicator reads Thread.ContextTokens, which
// only exists because this turns a completed turn's usage report into a
// persisted event — TurnCompleted's Usage was being silently dropped before.
func TestIngestionCarriesTurnUsageIntoContextTokens(t *testing.T) {
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
		Type: event.TurnCompleted, ThreadID: "w-abc",
		Payload: &event.TurnCompletedPayload{
			Status: "completed",
			// 10k new + 30k reused-from-cache + 5k newly cached = 45k actually
			// occupying the window for this request. OutputTokens (2k) must NOT
			// be counted — those are what the turn PRODUCED, not what was sent.
			Usage: &event.Usage{InputTokens: 10_000, OutputTokens: 2_000, CacheReadTokens: 30_000, CacheCreationTokens: 5_000},
		},
	}

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.ContextTokens == 45_000
	})

	th, _ := e.State().Thread("w-abc")
	if th.Status != ThreadIdle {
		t.Fatalf("status = %s, want idle (unrelated to the usage fix, but must still hold)", th.Status)
	}
}

// T1's capture verdict (capture/README.md "Open question 1"): denying
// ExitPlanMode's control_request still lets the CLI settle the turn to a
// terminal result on its own. So unlike RequestOpened/UserInputRequested,
// TurnProposedCompleted needs no defensive idle-dispatch — this test proves
// the ONLY thing this case must do: turn the captured plan into
// Thread.ProposedPlan, with every field carried through verbatim (the
// payload is decoded straight into CmdThreadPlanPropose, per
// command.go's PlanProposePayload doc comment).
func TestIngestionDispatchesPlanProposeOnTurnProposedCompleted(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")

	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.TurnProposedCompleted, ThreadID: "w-abc",
		Payload: &event.ProposedPlanPayload{
			PlanMarkdown: "# Do the thing\n\n- step one\n- step two",
			PlanFilePath: "/home/user/.claude/plans/do-the-thing.md",
			ToolUseID:    "toolu_01ABC",
		},
	}

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.ProposedPlan != nil
	})

	th, _ := e.State().Thread("w-abc")
	if th.ProposedPlan.PlanMarkdown != "# Do the thing\n\n- step one\n- step two" {
		t.Fatalf("PlanMarkdown = %q, want carried through verbatim", th.ProposedPlan.PlanMarkdown)
	}
	if th.ProposedPlan.PlanFilePath != "/home/user/.claude/plans/do-the-thing.md" {
		t.Fatalf("PlanFilePath = %q, want carried through verbatim", th.ProposedPlan.PlanFilePath)
	}
	if th.ProposedPlan.ToolUseID != "toolu_01ABC" {
		t.Fatalf("ToolUseID = %q, want carried through verbatim", th.ProposedPlan.ToolUseID)
	}
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

func (b *recordingBroker) Open(string, string)                  {}
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

// The exact shape of a server restart: a turn was in flight (its
// TurnStartRequested event committed, no TurnCompleted ever followed because
// the process died with the server), the log is replayed into a fresh
// engine — mirroring main.go's `Initial: Apply(NewState(), agentLog)` — and
// reconciliation must close it out as a durably persisted event, not just an
// in-memory patch.
func TestReconcileOrphanedThreadsClosesOutAnInFlightTurn(t *testing.T) {
	store := NewMemStore()
	prior := NewEngine(EngineOptions{Store: store, Now: func() int64 { return 1000 }, QueueSize: 8, NewID: func() string { return "ae-boot" }})
	ctx, cancel := context.WithCancel(context.Background())
	go prior.Run(ctx)
	dispatchCreate(t, prior, "w-abc")
	if _, err := prior.Dispatch(ctx, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hi"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}
	cancel() // the "process" dies mid-turn — nothing ever completes it

	// Boot a NEW engine against the same durable log, the way main.go does.
	n := 0
	e := NewEngine(EngineOptions{
		Store:   store,
		Initial: Apply(NewState(), store.All()),
		Now:     func() int64 { return 2000 },
		NewID:   func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	if th, ok := e.State().Thread("w-abc"); !ok || th.Status != ThreadRunning {
		t.Fatalf("replayed thread = %+v, want running (the orphaned-turn setup)", th)
	}
	bctx, bcancel := context.WithCancel(context.Background())
	defer bcancel()
	go e.Run(bctx)

	m := 0
	reconciled, err := ReconcileOrphanedThreads(bctx, e, func() string { m++; return "ac-reconcile-" + string(rune('a'+m)) })
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if reconciled != 1 {
		t.Fatalf("reconciled = %d, want 1", reconciled)
	}

	th, ok := e.State().Thread("w-abc")
	if !ok || th.Status != ThreadIdle {
		t.Fatalf("thread after reconcile = %+v, want idle", th)
	}

	// Durable, not just patched in memory: a THIRD boot against the same log
	// must land on idle without needing reconciliation to run again.
	third := Apply(NewState(), store.All())
	if th, ok := third.Thread("w-abc"); !ok || th.Status != ThreadIdle {
		t.Fatalf("re-replayed thread = %+v, want idle — the fix must be a persisted event", th)
	}
}

// A thread waiting on an approval when the process died is the other
// non-terminal status ReconcileOrphanedThreads must catch — and its pending
// request has to actually clear, not just its Status flip, or the approval UI
// keeps offering a prompt nothing will ever answer.
func TestReconcileOrphanedThreadsClearsAPendingApproval(t *testing.T) {
	store := NewMemStore()
	e := NewEngine(EngineOptions{Store: store, Now: func() int64 { return 1000 }, QueueSize: 8, NewID: func() string { return "ae-boot" }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")
	if _, err := e.Dispatch(ctx, Command{
		CommandID: "ac-wait", Type: CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"status": string(ThreadWaiting), "pendingRequestAdd": "req-1"}),
	}); err != nil {
		t.Fatalf("session set: %v", err)
	}

	n := 0
	if _, err := ReconcileOrphanedThreads(ctx, e, func() string { n++; return "ac-r" + string(rune('a'+n)) }); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	th, ok := e.State().Thread("w-abc")
	if !ok || th.Status != ThreadIdle {
		t.Fatalf("thread = %+v, want idle", th)
	}
	if len(th.PendingRequests) != 0 {
		t.Fatalf("PendingRequests = %v, want empty", th.PendingRequests)
	}
}

// Nothing to reconcile is the common case (a clean shutdown, or simply no
// chats mid-turn) — must be a silent no-op, not an error.
func TestReconcileOrphanedThreadsNoopsOnAnIdleThread(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	dispatchCreate(t, e, "w-abc")

	n := 0
	reconciled, err := ReconcileOrphanedThreads(context.Background(), e, func() string { n++; return "ac-r" + string(rune('a'+n)) })
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if reconciled != 0 {
		t.Fatalf("reconciled = %d, want 0", reconciled)
	}
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

// Regression: Ingestion's RequestOpened/UserInputRequested case dispatched only
// CmdThreadSessionSet, carrying the request id and nothing else. The canonical
// event's payload — the questions the agent is asking — was computed by the
// adapter and then delivered to nobody, so a waiting thread reached the client
// indistinguishable from a running one and no panel could render.
//
// Two commands now, and the ORDER is the assertion: activity first (what the
// panel renders), status second. A client that paints on status === waiting
// must never find an empty panel for a frame.
func TestUserInputRequestedForwardsActivityBeforeStatus(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")

	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.UserInputRequested, ThreadID: "w-abc", RequestID: "req-1",
		Payload: &event.UserInputRequestedPayload{Questions: json.RawMessage(`[{"id":"q1"}]`)},
	}

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.Status == ThreadWaiting
	})

	var activitySeq, sessionSetSeq uint64
	for _, ev := range store.All() {
		if ev.Type == EvtThreadActivityAppended && strings.Contains(string(ev.Payload), "req-1") {
			activitySeq = ev.Seq
		}
		if ev.Type == EvtThreadSessionSet && strings.Contains(string(ev.Payload), "req-1") {
			sessionSetSeq = ev.Seq
		}
	}
	if activitySeq == 0 {
		t.Fatalf("no activity event carried the request; store = %+v", store.All())
	}
	if sessionSetSeq == 0 {
		t.Fatalf("no session-set event carried the request; store = %+v", store.All())
	}
	if activitySeq >= sessionSetSeq {
		t.Fatalf("activity seq %d must come BEFORE session-set seq %d", activitySeq, sessionSetSeq)
	}

	// The questions themselves have to survive the trip, not just the id —
	// forwarding an envelope with an empty payload would satisfy the ordering
	// assertion above and still leave the panel with nothing to draw.
	var carried bool
	for _, ev := range store.All() {
		if ev.Type == EvtThreadActivityAppended && strings.Contains(string(ev.Payload), `"q1"`) {
			carried = true
		}
	}
	if !carried {
		t.Fatalf("the questions payload did not reach the client; store = %+v", store.All())
	}
}
