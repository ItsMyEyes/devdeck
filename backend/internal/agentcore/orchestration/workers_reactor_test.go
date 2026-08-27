package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

	mu                   sync.Mutex
	failSendTurn         bool
	sessionDead          bool
	startSessionInputs   []provider.SessionStartInput
	sendTurnCalls        []provider.SendTurnInput
	userInputCalls       []userInputCall
	interactionModeCalls []interactionModeCall
	runtimeModeCalls     []runtimeModeCall
}

// What the Reactor forwarded to the provider when the user answered. Recorded
// rather than merely counted, because the whole point of the case is that the
// answers reach the adapter intact.
type userInputCall struct {
	threadID  string
	requestID string
	answers   map[string]any
}

// What the Reactor forwarded when the composer's Plan pill flips —
// TestReactorSetsInteractionModeOnModeChange asserts both fields, not just
// that a call happened, because a wrong threadID or mode would silently
// switch the wrong thread's live session.
type interactionModeCall struct {
	threadID string
	mode     provider.InteractionMode
}

// What the Reactor forwarded when the composer's Permission pill changes —
// TestReactorSetsRuntimeModeOnModeChange asserts both fields for the same
// reason interactionModeCall does: a wrong threadID or mode would silently
// leave the wrong thread's live session asking under its old policy.
type runtimeModeCall struct {
	threadID string
	mode     provider.RuntimeMode
}

func (a *fakeAdapter) Kind() provider.Kind             { return fakeKind }
func (a *fakeAdapter) InstanceID() provider.InstanceID { return "fake:default" }
func (a *fakeAdapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{}
}
func (a *fakeAdapter) StartSession(_ context.Context, in provider.SessionStartInput) (provider.Session, error) {
	a.rec.record("StartSession")
	a.mu.Lock()
	a.startSessionInputs = append(a.startSessionInputs, in)
	// A fresh session is alive again — models the real adapters, whose
	// StartSession repopulates a.sessions[threadID].
	a.sessionDead = false
	a.mu.Unlock()
	return provider.Session{ThreadID: in.ThreadID}, nil
}

func (a *fakeAdapter) startInputs() []provider.SessionStartInput {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]provider.SessionStartInput(nil), a.startSessionInputs...)
}

// setSessionDead simulates the per-thread CLI process exiting: the real
// adapters' readLoop deletes a.sessions[threadID] on stdout close while the
// instance adapter itself stays registered, so HasSession then reports false.
func (a *fakeAdapter) setSessionDead(v bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sessionDead = v
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
func (a *fakeAdapter) RespondToUserInput(_ context.Context, threadID, requestID string, answers map[string]any) error {
	a.rec.record("RespondToUserInput")
	a.mu.Lock()
	defer a.mu.Unlock()
	a.userInputCalls = append(a.userInputCalls, userInputCall{threadID, requestID, answers})
	return nil
}

func (a *fakeAdapter) userInputSnapshot() []userInputCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]userInputCall(nil), a.userInputCalls...)
}
func (a *fakeAdapter) SetInteractionMode(_ context.Context, threadID string, mode provider.InteractionMode) error {
	a.rec.record("SetInteractionMode")
	a.mu.Lock()
	defer a.mu.Unlock()
	a.interactionModeCalls = append(a.interactionModeCalls, interactionModeCall{threadID, mode})
	return nil
}
func (a *fakeAdapter) interactionModeSnapshot() []interactionModeCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]interactionModeCall(nil), a.interactionModeCalls...)
}
func (a *fakeAdapter) SetRuntimeMode(_ context.Context, threadID string, mode provider.RuntimeMode) error {
	a.rec.record("SetRuntimeMode")
	a.mu.Lock()
	defer a.mu.Unlock()
	a.runtimeModeCalls = append(a.runtimeModeCalls, runtimeModeCall{threadID, mode})
	return nil
}
func (a *fakeAdapter) runtimeModeSnapshot() []runtimeModeCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]runtimeModeCall(nil), a.runtimeModeCalls...)
}

// StopSession models the real per-process adapters: the thread's session is
// gone the moment this returns (HasSession false), and nothing is emitted —
// see claude/adapter.go's session.stopped.
func (a *fakeAdapter) StopSession(context.Context, string) error {
	a.rec.record("StopSession")
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sessionDead = true
	return nil
}
func (a *fakeAdapter) StopAll(context.Context) error { return nil }
func (a *fakeAdapter) HasSession(string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.sessionDead
}
func (a *fakeAdapter) ListSessions() []provider.Session { return nil }
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

func (b orderingBroker) Open(string, string)                  {}
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
	return newReactorHarnessWithState(t, brokerFn, nil)
}

// newReactorHarnessWithState is newReactorHarness plus a pre-seeded engine
// State — i.e. a thread the decider knows about that the REACTOR has never
// seen an EvtThreadCreated for. That is precisely what a server restart looks
// like: main.go replays the durable log into State on boot, but the one-time
// creation event does not re-fire, so nothing re-binds the thread to a
// provider instance.
func newReactorHarnessWithState(t *testing.T, brokerFn func(rec *callRecorder) approval.Broker, initial *State) *reactorHarness {
	t.Helper()
	rec := &callRecorder{}
	adapter := &fakeAdapter{rec: rec, ch: make(chan event.Event, 4)}
	registry := provider.NewRegistry(&fakeDriver{rec: rec, adapter: adapter})
	dir := &recordingDir{rec: rec, inner: NewThreadDirectory()}
	svc := &provider.Service{Registry: registry, Dir: dir}

	store := NewMemStore()
	h := &reactorHarness{adapter: adapter, rec: rec, store: store}
	h.engine = NewEngine(EngineOptions{
		Store: store, Initial: initial, Now: func() int64 { return 1000 }, QueueSize: 16,
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
	h.reactor.Start(ctx)
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

// Regression: a worktree with an empty Agent produced InstanceID ":default",
// whose Kind is the empty string. That matched no driver and reported
// "no driver registered for " — a blank where the agent name should be —
// after which every turn failed with "thread is not bound to an instance".
// All three worktrees in a real install were root worktrees with no agent, so
// this was the default experience, not an edge case.
func TestUnresolvedAgentReportsAConfigurationError(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.reactor.InstanceFor = func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
		return ":default", provider.SessionStartInput{ThreadID: threadID}, nil
	}

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))

	// The failure must reach the thread as a visible error, not just a log
	// line — that silence is what made this take four rounds to find.
	waitFor(t, func() bool {
		for _, e := range h.store.All() {
			if e.Type != EvtThreadActivityAppended {
				continue
			}
			if strings.Contains(string(e.Payload), "no agent configured") {
				return true
			}
		}
		return false
	})
}

// A restarted server replays its event log into State but never re-fires
// EvtThreadCreated, so nothing re-binds the thread to a provider instance.
// The thread then looks perfectly healthy — log intact, decider accepts the
// turn — while every turn dies in adapterFor at "not bound to an instance".
// The reactor has to provision on the turn, not only on creation.
func TestReactorStartsASessionForATurnOnAThreadItNeverSawCreated(t *testing.T) {
	created := Event{
		EventID: "ae-seed", Type: EvtThreadCreated, ThreadID: "w-abc",
		CreatedAt: 1000, Payload: mustRaw(t, map[string]any{}),
	}
	h := newReactorHarnessWithState(t, noopBrokerFn, Apply(NewState(), []Event{created}))
	defer h.cancel()

	// No CmdThreadCreate: the thread already exists, exactly as after a boot.
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "fix the auth redirect"}))

	h.waitForCall(t, "StartSession")
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	if n := countErrorEntries(h.store.All()); n != 0 {
		t.Fatalf("turn reported %d errors, want none", n)
	}
}

// ensureSession runs on every turn, so it must be a no-op once the thread is
// already bound and its adapter is alive — restarting the CLI session under a
// running conversation would silently drop the agent's context.
func TestReactorDoesNotRestartTheSessionOnEveryTurn(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "one"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "two"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 2 })

	starts := 0
	for _, c := range h.rec.snapshot() {
		if c == "StartSession" {
			starts++
		}
	}
	if starts != 1 {
		t.Fatalf("StartSession called %d times across two turns, want 1", starts)
	}
}

// The pi bug behind "the agent stopped by itself and now nothing happens when
// I type": a provider with a per-thread child process (pi, claude) can have
// that process die mid-life — its readLoop deletes a.sessions[threadID] — while
// the INSTANCE adapter (one per instance, shared across threads) stays
// registered. ensureSession only checked that the instance adapter was alive,
// so it returned "already ready" without restarting, and the next SendTurn hit
// an adapter with no session for the thread: it returned "no active session"
// and emitted no TurnStarted, so the UI showed no spinner and no error — the
// turn silently did nothing. The reactor must restart the dead session first.
func TestReactorRestartsADeadSessionOnTheNextTurn(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	// The CLI process exits: the per-thread session is gone, the instance
	// adapter stays registered.
	h.adapter.setSessionDead(true)

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "continue"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })

	starts := 0
	for _, c := range h.rec.snapshot() {
		if c == "StartSession" {
			starts++
		}
	}
	if starts != 2 {
		t.Fatalf("StartSession called %d times across the turn, want 2 — a dead session must be restarted before SendTurn", starts)
	}
	if n := countErrorEntries(h.store.All()); n != 0 {
		t.Fatalf("turn reported %d errors, want none once the session is restarted", n)
	}
}

// Restarting a dead session must carry the thread's stored resume cursor into
// the fresh StartSession, or "continue" reattaches a blank CLI that has
// forgotten the whole conversation — for pi this is the native --session id, so
// the restarted process resumes the same on-disk session instead of a new one.
func TestReactorRestartResumesTheDeadSessionWithItsCursor(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	// The provider announced its native session id (pi's get_state response,
	// claude's init): the engine stored it as the thread's resume cursor.
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status":       string(ThreadIdle),
		"resumeCursor": json.RawMessage(`"pi-session-uuid"`),
	}))

	h.adapter.setSessionDead(true)
	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "continue"}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })

	inputs := h.adapter.startInputs()
	if len(inputs) != 2 {
		t.Fatalf("StartSession called %d times, want 2 (initial + restart)", len(inputs))
	}
	if got := string(inputs[1].ResumeCursor); got != `"pi-session-uuid"` {
		t.Fatalf("restart ResumeCursor = %q, want the stored cursor so the conversation survives", got)
	}
}

// The composer's picker names an instance on the turn. Selecting the one the
// thread is already on must not churn the session.
func TestReactorKeepsTheSessionWhenTheTurnNamesTheBoundInstance(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:  "stay put",
		Model: provider.ModelSelection{InstanceID: "fake:default", Model: "fake-mini"},
	}))
	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })

	starts := 0
	for _, c := range h.rec.snapshot() {
		if c == "StartSession" {
			starts++
		}
	}
	if starts != 1 {
		t.Fatalf("StartSession called %d times, want 1 — naming the bound instance must be a no-op", starts)
	}
	// And the chosen model actually reaches the adapter, which is the whole
	// point: the pill was decorative before this.
	if got := h.adapter.turnCalls()[0].Model.Model; got != "fake-mini" {
		t.Fatalf("SendTurn model = %q, want fake-mini", got)
	}
}

// threadStatus reads the thread's current status out of engine State.
func threadStatus(t *testing.T, h *reactorHarness, threadID string) ThreadStatus {
	t.Helper()
	th, ok := h.engine.State().Thread(threadID)
	if !ok {
		t.Fatalf("thread %s not in state", threadID)
	}
	return th.Status
}

// A reactor error is a side effect that did NOT happen — the turn was never
// delivered — so nothing downstream will ever move the thread off Running.
// Reporting the error alone left the transcript showing "Working for 1877s"
// under a failed turn, with the composer stuck on Stop.
func TestReactorSettlesThreadAfterReportingError(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()
	h.adapter.setFailSendTurn(true)

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "hi"}))
	waitFor(t, func() bool { return countErrorEntries(h.store.All()) == 1 })

	// The error is reported AND the thread is no longer running.
	waitFor(t, func() bool {
		th, ok := h.engine.State().Thread("w-abc")
		return ok && th.Status != ThreadRunning
	})
	if got := threadStatus(t, h, "w-abc"); got != ThreadIdle {
		t.Fatalf("status = %s, want idle after a failed turn", got)
	}
}

// Stop has to be a way OUT of running, not a request that may be ignored.
// `InterruptTurn` is best-effort by contract — the claude adapter returns nil
// both when it delivered the control_request and when it holds no session for
// the thread at all — so without this a thread whose process had already died
// stayed Running forever with Stop as its only, useless, control.
func TestInterruptSettlesThreadEvenWhenTheProviderIgnoresIt(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "hi"}))
	waitFor(t, func() bool { return threadStatus(t, h, "w-abc") == ThreadRunning })

	// fakeAdapter.InterruptTurn only records the call — it never answers with
	// TurnAborted, which is exactly the wedged-provider case.
	h.dispatch(t, "w-abc", CmdThreadTurnInterrupt, nil)
	h.waitForCall(t, "InterruptTurn")

	waitFor(t, func() bool { return threadStatus(t, h, "w-abc") != ThreadRunning })
	if got := threadStatus(t, h, "w-abc"); got != ThreadIdle {
		t.Fatalf("status = %s, want idle after an ignored interrupt", got)
	}
}

// Regression for a silent no-op: EvtThreadUserInputResponseRequested fell
// through react's switch to `return nil`. The pending flag cleared and the
// thread flipped waiting -> running, so the UI looked answered — while the
// provider was never told anything and the agent stayed blocked forever.
func TestReactorRespondsToUserInput(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status": string(ThreadWaiting), "pendingRequestAdd": "req-1",
	}))

	h.dispatch(t, "w-abc", CmdThreadUserInputRespond, mustRaw(t, UserInputRespondPayload{
		RequestID: "req-1",
		Answers:   map[string]any{"Tabs or spaces?": "Tabs"},
	}))

	h.waitForCall(t, "RespondToUserInput")
	calls := h.adapter.userInputSnapshot()
	if len(calls) != 1 {
		t.Fatalf("userInputCalls = %+v, want exactly one", calls)
	}
	if calls[0].threadID != "w-abc" || calls[0].requestID != "req-1" {
		t.Fatalf("call routed wrong: %+v", calls[0])
	}
	// Keyed by the full question text — the CLI looks answers up by it, so a
	// re-keyed map reaches the agent as no answer at all.
	if got := calls[0].answers["Tabs or spaces?"]; got != "Tabs" {
		t.Fatalf("answers = %+v, want the answer under its question text", calls[0].answers)
	}
}

// T1's capture verdict (capture/README.md "Open question 2"): set_permission_mode
// is accepted on an already-running session, so §4's path (a) is what ships —
// no restart, no StopSession/Unbind/StartSession sequence. Before this case
// existed, EvtThreadInteractionModeSet fell through react's switch to `return
// nil`: the composer's Plan pill flipped Thread.Interact in the read model but
// the live CLI process never heard about it, so --permission-mode plan only
// ever reached a session that happened to start AFTER the flag was already
// set (a restart, or a dead-and-reprovisioned process) — never the ordinary
// "open a chat, press Plan, type" flow the spec's problem #2 describes.
func TestReactorSetsInteractionModeOnModeChange(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadInteractionModeSet, mustRaw(t, InteractionModeSetPayload{
		Mode: provider.InteractionPlan,
	}))
	h.waitForCall(t, "SetInteractionMode")

	calls := h.adapter.interactionModeSnapshot()
	if len(calls) != 1 {
		t.Fatalf("interactionModeCalls = %+v, want exactly one", calls)
	}
	if calls[0].threadID != "w-abc" || calls[0].mode != provider.InteractionPlan {
		t.Fatalf("call = %+v, want {threadID: w-abc, mode: plan}", calls[0])
	}
}

// Before SetRuntimeMode existed, EvtThreadRuntimeModeSet only ever reached
// approval.Gate.ReleasePending (DevDeck's own SSH-tool approval cards) — it
// never told the live provider adapter anything. The composer's Permission
// pill flipped Thread.Mode in the read model, but a running claude/codex/pi
// process kept enforcing whatever --permission-mode/approvalPolicy it was
// launched with for the rest of the session: an operator switching to auto
// or full access (or back to approval-required) kept getting asked exactly
// as before, no matter what the pill now said. This is the live-provider
// half of that fix — ReleasePending's own coverage lives in
// workers_runtimemode_test.go.
func TestReactorSetsRuntimeModeOnModeChange(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadRuntimeModeSet, mustRaw(t, RuntimeModeSetPayload{
		Mode: provider.ModeFullAccess,
	}))
	h.waitForCall(t, "SetRuntimeMode")

	calls := h.adapter.runtimeModeSnapshot()
	if len(calls) != 1 {
		t.Fatalf("runtimeModeCalls = %+v, want exactly one", calls)
	}
	if calls[0].threadID != "w-abc" || calls[0].mode != provider.ModeFullAccess {
		t.Fatalf("call = %+v, want {threadID: w-abc, mode: full-access}", calls[0])
	}
}

// The decider's double-tap guard has to cover user input the same way it
// covers approvals: a second device answering an already-retired request must
// not reach the provider a second time.
func TestReactorIgnoresUserInputForARetiredRequest(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status": string(ThreadWaiting), "pendingRequestAdd": "req-1",
	}))

	payload := mustRaw(t, UserInputRespondPayload{
		RequestID: "req-1", Answers: map[string]any{"q": "a"},
	})
	h.dispatch(t, "w-abc", CmdThreadUserInputRespond, payload)
	h.waitForCall(t, "RespondToUserInput")

	// Same request, a fresh command id — this is what a second device looks
	// like, and SeenCommand cannot catch it. The decider must reject it, so
	// this dispatch is EXPECTED to error; h.dispatch would call t.Fatal on it.
	h.cmdSeq++
	_, err := h.engine.Dispatch(context.Background(), Command{
		CommandID: fmt.Sprintf("ac-%d", h.cmdSeq),
		Type:      CmdThreadUserInputRespond, ThreadID: "w-abc", Payload: payload,
	})
	if err == nil {
		t.Fatal("answering an already-retired request should be rejected by the decider")
	}

	if calls := h.adapter.userInputSnapshot(); len(calls) != 1 {
		t.Fatalf("userInputCalls = %+v, want the second answer never to reach the provider", calls)
	}
}

// Leaving Plan mode used to hand the thread's permission policy away.
//
// provider.InteractionMode's two values ARE claude's own --permission-mode
// names, which is what lets SetInteractionMode send them untranslated — but it
// means exiting plan sends `set_permission_mode: "default"`, and "default" is
// the CLI's ASK-FOR-EVERYTHING mode. A thread sitting in full access that
// visited Plan mode once came back gated: the Permission pill still read "Full
// access" (nothing touched Thread.Mode) while the live process asked for every
// command, which is the same operator-facing symptom as never having pushed
// the mode at all.
//
// So the runtime mode is re-asserted on the way out, and ONLY on the way out —
// entering plan must not immediately undo itself.
func TestReactorReassertsRuntimeModeWhenLeavingPlanMode(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadRuntimeModeSet, mustRaw(t, RuntimeModeSetPayload{
		Mode: provider.ModeFullAccess,
	}))
	h.waitForCall(t, "SetRuntimeMode")

	// Entering plan: the interaction mode goes down, the runtime mode does not
	// move (plan deliberately outranks it while it is on).
	h.dispatch(t, "w-abc", CmdThreadInteractionModeSet, mustRaw(t, InteractionModeSetPayload{
		Mode: provider.InteractionPlan,
	}))
	h.waitForCall(t, "SetInteractionMode")
	if got := len(h.adapter.runtimeModeSnapshot()); got != 1 {
		t.Fatalf("runtimeModeCalls = %d after ENTERING plan, want 1 — plan must not re-push", got)
	}

	// Leaving it: "default" reaches the CLI, and the thread's own mode has to
	// follow it back.
	h.dispatch(t, "w-abc", CmdThreadInteractionModeSet, mustRaw(t, InteractionModeSetPayload{
		Mode: provider.InteractionDefault,
	}))
	// Not waitForCall: "SetRuntimeMode" is already in the recorder from the
	// pill change above, so it would return without waiting for anything.
	waitFor(t, func() bool { return len(h.adapter.runtimeModeSnapshot()) == 2 })

	calls := h.adapter.runtimeModeSnapshot()
	if len(calls) != 2 {
		t.Fatalf("runtimeModeCalls = %+v, want two — the second re-asserts the thread's mode after plan", calls)
	}
	if calls[1].threadID != "w-abc" || calls[1].mode != provider.ModeFullAccess {
		t.Fatalf("call = %+v, want {threadID: w-abc, mode: full-access}", calls[1])
	}
}
