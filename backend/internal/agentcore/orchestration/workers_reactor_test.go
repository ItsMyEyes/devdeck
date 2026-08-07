package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// Reactor had ZERO tests before this file. Nothing in production ever calls
// StartInstance, Dir.Bind, or StartSession, so every turn died at "provider:
// thread %s is not bound to an instance" — this is the harness that proves
// provisioning actually happens.
//
// provider.Service is a concrete struct, not an interface, so it cannot be
// faked directly. Instead these tests wire a real provider.Registry and
// provider.Service to a fake Driver/Adapter pair, which is what actually
// exercises Service.SendTurn / RespondToRequest / InterruptTurn end to end.

// callRecorder captures the ORDER of calls across the fake driver, adapter,
// and thread directory — the exact thing TestReactorProvisionsOnThreadCreated
// needs to assert.
type callRecorder struct {
	mu    sync.Mutex
	calls []string
}

func (c *callRecorder) record(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, s)
}

func (c *callRecorder) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.calls...)
}

const fakeKind provider.Kind = "fake"

type fakeConfig struct{}

func (fakeConfig) ProviderKind() provider.Kind { return fakeKind }

// fakeDriver's Create is what backs Registry.StartInstance.
type fakeDriver struct {
	rec     *callRecorder
	adapter *fakeAdapter
}

func (d *fakeDriver) Kind() provider.Kind            { return fakeKind }
func (d *fakeDriver) DefaultConfig() json.RawMessage { return json.RawMessage(`{}`) }
func (d *fakeDriver) DecodeConfig(json.RawMessage) (provider.Config, error) {
	return fakeConfig{}, nil
}
func (d *fakeDriver) Probe(context.Context, provider.Config) (provider.Snapshot, error) {
	return provider.Snapshot{}, nil
}
func (d *fakeDriver) Create(context.Context, provider.InstanceSpec) (provider.Adapter, error) {
	d.rec.record("StartInstance")
	return d.adapter, nil
}

var _ provider.Driver = (*fakeDriver)(nil)

// fakeAdapter records every call it receives, and SendTurn can be toggled to
// fail so TestReactorReportsFailedSendTurn can force the reportError path.
type fakeAdapter struct {
	rec *callRecorder
	ch  chan event.Event

	mu            sync.Mutex
	failSendTurn  bool
	sendTurnCalls []provider.SendTurnInput
}

func (a *fakeAdapter) Kind() provider.Kind             { return fakeKind }
func (a *fakeAdapter) InstanceID() provider.InstanceID { return "fake:default" }
func (a *fakeAdapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{}
}
func (a *fakeAdapter) StartSession(_ context.Context, in provider.SessionStartInput) (provider.Session, error) {
	a.rec.record("StartSession")
	return provider.Session{ThreadID: in.ThreadID}, nil
}
func (a *fakeAdapter) SendTurn(_ context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.rec.record("SendTurn")
	a.mu.Lock()
	a.sendTurnCalls = append(a.sendTurnCalls, in)
	fail := a.failSendTurn
	a.mu.Unlock()
	if fail {
		return provider.TurnStartResult{}, errors.New("boom: provider unreachable")
	}
	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}
func (a *fakeAdapter) InterruptTurn(context.Context, string, string) error {
	a.rec.record("InterruptTurn")
	return nil
}
func (a *fakeAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *fakeAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *fakeAdapter) StopSession(context.Context, string) error { return nil }
func (a *fakeAdapter) StopAll(context.Context) error             { return nil }
func (a *fakeAdapter) HasSession(string) bool                    { return true }
func (a *fakeAdapter) ListSessions() []provider.Session          { return nil }
func (a *fakeAdapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *fakeAdapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *fakeAdapter) Events() <-chan event.Event { return a.ch }

func (a *fakeAdapter) turnCalls() []provider.SendTurnInput {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]provider.SendTurnInput(nil), a.sendTurnCalls...)
}

func (a *fakeAdapter) setFailSendTurn(v bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failSendTurn = v
}

var _ provider.Adapter = (*fakeAdapter)(nil)

// recordingDir wraps the real threadDirectory so Bind's position in the call
// order is observable, while Bind/InstanceFor still behave exactly as
// production code sees them.
type recordingDir struct {
	rec   *callRecorder
	inner provider.ThreadDirectory
}

func (d *recordingDir) InstanceFor(threadID string) (provider.InstanceID, bool) {
	return d.inner.InstanceFor(threadID)
}
func (d *recordingDir) Bind(threadID string, id provider.InstanceID) {
	d.rec.record("Bind")
	d.inner.Bind(threadID, id)
}
func (d *recordingDir) Unbind(threadID string) { d.inner.Unbind(threadID) }

var _ provider.ThreadDirectory = (*recordingDir)(nil)

// orderingBroker records CancelThread into the shared recorder so
// TestReactorCancelsApprovalsBeforeInterrupting can assert ordering against
// the adapter's InterruptTurn call.
type orderingBroker struct{ rec *callRecorder }

func (b orderingBroker) Resolve(string, event.Decision) error { return approval.ErrUnknownRequest }
func (b orderingBroker) CancelThread(string)                  { b.rec.record("CancelThread") }

var _ approval.Broker = orderingBroker{}

// reactorHarness wires a real Engine + Reactor to the fakes above, with
// InstanceFor resolving every thread to the same fake instance — standing in
// for "the worktree's configured agent", which main.go derives for real.
type reactorHarness struct {
	engine  *Engine
	reactor *Reactor
	adapter *fakeAdapter
	rec     *callRecorder
	store   *MemStore
	cancel  context.CancelFunc

	cmdSeq int
	idSeq  int

	// consumed records every adapter OnInstanceStarted fired for, so a test
	// can assert Ingestion is started exactly once per instance.
	mu       sync.Mutex
	consumed []provider.InstanceID
}

func (h *reactorHarness) consumedSnapshot() []provider.InstanceID {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]provider.InstanceID(nil), h.consumed...)
}

// newReactorHarness wires everything through one shared callRecorder so
// provisioning order (driver/adapter/directory) and broker order can both be
// asserted against the same timeline. brokerFn lets a test observe broker
// calls on that same recorder.
func newReactorHarness(t *testing.T, brokerFn func(rec *callRecorder) approval.Broker) *reactorHarness {
	t.Helper()
	rec := &callRecorder{}
	adapter := &fakeAdapter{rec: rec, ch: make(chan event.Event, 4)}
	registry := provider.NewRegistry(&fakeDriver{rec: rec, adapter: adapter})
	dir := &recordingDir{rec: rec, inner: NewThreadDirectory()}
	svc := &provider.Service{Registry: registry, Dir: dir}

	store := NewMemStore()
	h := &reactorHarness{adapter: adapter, rec: rec, store: store}
	h.engine = NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { h.idSeq++; return fmt.Sprintf("ae-%d", h.idSeq) },
	})

	h.reactor = &Reactor{
		Engine: h.engine, Provider: svc, Broker: brokerFn(rec),
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			return "fake:default", provider.SessionStartInput{ThreadID: threadID, Cwd: "/tmp/w-abc"}, nil
		},
		OnInstanceStarted: func(_ context.Context, a provider.Adapter) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.consumed = append(h.consumed, a.InstanceID())
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go h.engine.Run(ctx)
	go h.reactor.Run(ctx)
	return h
}

func noopBrokerFn(*callRecorder) approval.Broker { return approval.NoopBroker{} }

func (h *reactorHarness) dispatch(t *testing.T, threadID string, typ CommandType, payload json.RawMessage) []Event {
	t.Helper()
	h.cmdSeq++
	evts, err := h.engine.Dispatch(context.Background(), Command{
		CommandID: fmt.Sprintf("ac-%d", h.cmdSeq), Type: typ, ThreadID: threadID, Payload: payload,
	})
	if err != nil {
		t.Fatalf("dispatch %s: %v", typ, err)
	}
	return evts
}

func (h *reactorHarness) waitForCall(t *testing.T, name string) {
	t.Helper()
	waitFor(t, func() bool {
		for _, c := range h.rec.snapshot() {
			if c == name {
				return true
			}
		}
		return false
	})
}

// TestReactorProvisionsOnThreadCreated is THE test spec 1 lacked: nothing
// ever called StartInstance, Bind, or StartSession, so every turn died at
// "provider: thread %s is not bound to an instance". This proves the order
// is exactly StartInstance -> Bind -> StartSession.
func TestReactorProvisionsOnThreadCreated(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	calls := h.rec.snapshot()
	idx := map[string]int{}
	for i, c := range calls {
		if _, ok := idx[c]; !ok {
			idx[c] = i
		}
	}
	if !(idx["StartInstance"] < idx["Bind"] && idx["Bind"] < idx["StartSession"]) {
		t.Fatalf("call order = %v, want StartInstance -> Bind -> StartSession", calls)
	}
}

// TestReactorSendsTurnOnceThreadIsBound proves a turn.start after creation
// actually reaches SendTurn — the concrete symptom of the missing
// provisioning was every turn dying before this call was ever made.
func TestReactorSendsTurnOnceThreadIsBound(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "fix the auth redirect"}))

	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	calls := h.adapter.turnCalls()
	if calls[0].ThreadID != "w-abc" {
		t.Fatalf("SendTurn threadID = %q, want w-abc", calls[0].ThreadID)
	}
}

// TestReactorReportsFailedSendTurn proves the mechanism built to surface
// provider failures actually surfaces them: reportError dispatches
// CmdThreadActivityAppend, which Task 1 gave a decider rule.
func TestReactorReportsFailedSendTurn(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()
	h.adapter.setFailSendTurn(true)

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "fix the auth redirect"}))

	waitFor(t, func() bool { return countErrorEntries(h.store.All()) == 1 })

	// Give the (deliberately single-shot) reactor time to settle, then prove
	// the error entry did not get reported twice.
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	if n := countErrorEntries(h.store.All()); n != 1 {
		t.Fatalf("error entries = %d, want exactly 1", n)
	}
}

func countErrorEntries(evts []Event) int {
	n := 0
	for _, e := range evts {
		if e.Type != EvtThreadActivityAppended {
			continue
		}
		var p struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(e.Payload, &p)
		if p.Kind == "runtime.error" {
			n++
		}
	}
	return n
}

// TestReactorCancelsApprovalsBeforeInterrupting proves the interrupt path
// cancels pending approvals BEFORE calling into the provider — otherwise the
// interrupt would wait on a turn that is itself waiting on the user.
func TestReactorCancelsApprovalsBeforeInterrupting(t *testing.T) {
	h := newReactorHarness(t, func(rec *callRecorder) approval.Broker {
		return orderingBroker{rec: rec}
	})
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnInterrupt, nil)
	h.waitForCall(t, "InterruptTurn")

	calls := h.rec.snapshot()
	cancelIdx, interruptIdx := -1, -1
	for i, c := range calls {
		if c == "CancelThread" && cancelIdx == -1 {
			cancelIdx = i
		}
		if c == "InterruptTurn" && interruptIdx == -1 {
			interruptIdx = i
		}
	}
	if cancelIdx == -1 || interruptIdx == -1 || cancelIdx > interruptIdx {
		t.Fatalf("call order = %v, want CancelThread before InterruptTurn", calls)
	}
}

// Regression: main.go started the engine and the Reactor but never an
// Ingestion, so nothing drained Adapter.Events(). The provider -> engine
// direction had no consumer at all: the adapter's buffered channel filled and
// then silently dropped every delta and tool call, leaving a chat that echoed
// the user's own message and then went quiet. All backend tests were green.
func TestReactorStartsIngestionOncePerFreshInstance(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	waitFor(t, func() bool { return len(h.consumedSnapshot()) == 1 })
	if got := h.consumedSnapshot(); got[0] != "fake:default" {
		t.Fatalf("consumed %v, want [fake:default]", got)
	}

	// A second thread shares the same instance. Starting a second Consume loop
	// on one adapter would make two goroutines race for the same channel, so
	// each would see only some of the events.
	h.dispatch(t, "w-def", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "Bind")

	time.Sleep(100 * time.Millisecond)
	if got := h.consumedSnapshot(); len(got) != 1 {
		t.Fatalf("consumed %v, want exactly one — a shared instance must not be consumed twice", got)
	}
}
