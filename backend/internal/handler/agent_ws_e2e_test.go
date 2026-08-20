package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"

	"nhooyr.io/websocket"
)

// This is the test spec 1 lacked. Every task in this plan (and every critical
// finding in spec 1's review) lived in the seam between layers — the decider
// gap, the missing provisioning, the replay race — and every unit test in
// every task's own file passed regardless, because none of them crossed the
// seam. This test dials the real /ws/agent socket and drives a turn all the
// way through engine -> Reactor -> ThreadDirectory -> Adapter and back, with
// a fake Driver/Adapter standing in for a real agent process.

// e2eFakeKind identifies the fake driver. The test worktree's Agent field is
// set to this string so hello's auto-create resolves InstanceID to
// "e2efake:default", which is exactly what the fake Registry has a Driver
// for.
const e2eFakeKind provider.Kind = "e2efake"

type e2eFakeConfig struct{}

func (e2eFakeConfig) ProviderKind() provider.Kind { return e2eFakeKind }

// e2eFakeDriver.Create backs Registry.StartInstance, called from the
// Reactor's EvtThreadCreated case. It always returns the one pre-built
// adapter below rather than constructing a new one, so the test can hold a
// reference to it (and its Events() channel) before the socket is even
// dialed.
type e2eFakeDriver struct{ adapter *e2eFakeAdapter }

func (d *e2eFakeDriver) Kind() provider.Kind            { return e2eFakeKind }
func (d *e2eFakeDriver) DefaultConfig() json.RawMessage { return json.RawMessage(`{}`) }
func (d *e2eFakeDriver) DecodeConfig(json.RawMessage) (provider.Config, error) {
	return e2eFakeConfig{}, nil
}
func (d *e2eFakeDriver) Probe(context.Context, provider.Config) (provider.Snapshot, error) {
	return provider.Snapshot{}, nil
}
func (d *e2eFakeDriver) Create(context.Context, provider.InstanceSpec) (provider.Adapter, error) {
	return d.adapter, nil
}

var _ provider.Driver = (*e2eFakeDriver)(nil)

// e2eFakeAdapter stands in for a real agent process. It records every
// StartSession/SendTurn call it receives and lets the test push synthetic
// provider events (ContentDelta, ItemStarted) back through Events(), exactly
// as a real adapter would forward parsed NDJSON from the agent's stdout.
type e2eFakeAdapter struct {
	ch chan event.Event

	mu                sync.Mutex
	startSessionCalls []provider.SessionStartInput
	sendTurnCalls     []provider.SendTurnInput
}

func (a *e2eFakeAdapter) Kind() provider.Kind             { return e2eFakeKind }
func (a *e2eFakeAdapter) InstanceID() provider.InstanceID { return "e2efake:default" }
func (a *e2eFakeAdapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{}
}
func (a *e2eFakeAdapter) StartSession(_ context.Context, in provider.SessionStartInput) (provider.Session, error) {
	a.mu.Lock()
	a.startSessionCalls = append(a.startSessionCalls, in)
	a.mu.Unlock()
	return provider.Session{ThreadID: in.ThreadID}, nil
}
func (a *e2eFakeAdapter) SendTurn(_ context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	a.sendTurnCalls = append(a.sendTurnCalls, in)
	a.mu.Unlock()
	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}
func (a *e2eFakeAdapter) InterruptTurn(context.Context, string, string) error { return nil }
func (a *e2eFakeAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *e2eFakeAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *e2eFakeAdapter) SetInteractionMode(context.Context, string, provider.InteractionMode) error {
	return nil
}
func (a *e2eFakeAdapter) SetRuntimeMode(context.Context, string, provider.RuntimeMode) error {
	return nil
}
func (a *e2eFakeAdapter) StopSession(context.Context, string) error { return nil }
func (a *e2eFakeAdapter) StopAll(context.Context) error             { return nil }
func (a *e2eFakeAdapter) HasSession(string) bool                    { return true }
func (a *e2eFakeAdapter) ListSessions() []provider.Session          { return nil }
func (a *e2eFakeAdapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *e2eFakeAdapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *e2eFakeAdapter) Events() <-chan event.Event { return a.ch }

func (a *e2eFakeAdapter) snapshotStartSessionCalls() []provider.SessionStartInput {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]provider.SessionStartInput(nil), a.startSessionCalls...)
}

func (a *e2eFakeAdapter) snapshotSendTurnCalls() []provider.SendTurnInput {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]provider.SendTurnInput(nil), a.sendTurnCalls...)
}

var _ provider.Adapter = (*e2eFakeAdapter)(nil)

func e2eWaitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 5s")
}

// TestAgentWSE2ETurnCrossesEveryLayer is THE seam-crossing test: a thread
// with no prior events, dialed cold over /ws/agent, must reach a fake
// adapter's SendTurn — and a tool call fed back through that same adapter
// must reach the client. Every critical finding in spec 1's review (the
// decider gap, the missing provisioning, the replay race) lived in exactly
// this seam, and every task's own unit tests passed regardless, because none
// of them crossed it.
func TestAgentWSE2ETurnCrossesEveryLayer(t *testing.T) {
	engine, st, threadID, cleanup := newAgentWSTestEnv(t, "e2efake")
	defer cleanup()

	adapter := &e2eFakeAdapter{ch: make(chan event.Event, 8)}
	registry := provider.NewRegistry(&e2eFakeDriver{adapter: adapter})
	dir := orchestration.NewThreadDirectory()
	svc := &provider.Service{Registry: registry, Dir: dir}

	reactor := &orchestration.Reactor{
		Engine: engine, Provider: svc, Broker: approval.NoopBroker{},
		// Mirrors main.go's InstanceFor: thread id -> worktree -> configured
		// agent. The test worktree's Agent field is "e2efake", so this
		// resolves to the one instance the fake Registry knows how to build.
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			wt, err := st.WorktreeByID(threadID)
			if err != nil {
				return "", provider.SessionStartInput{}, err
			}
			return provider.InstanceID(wt.Agent + ":default"), provider.SessionStartInput{
				ThreadID: threadID,
				Cwd:      wt.Path,
			}, nil
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go reactor.Run(ctx)

	// Ingestion is what turns the fake adapter's synthetic events back into
	// commands the engine understands — the inbound half of the seam. Nothing
	// in cmd/server/main.go wires this yet for the real Claude adapter, but
	// the seam itself is what this test proves, independent of that gap.
	idSeq := 0
	ingestion := orchestration.NewIngestion(engine, approval.NoopBroker{}, func() string {
		idSeq++
		return "ac-in-" + strconv.Itoa(idSeq)
	})
	go ingestion.Consume(ctx, adapter)

	h := NewAgentWSHandler(engine, st, svc)
	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	wctx, wcancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer wcancel()

	c, _, err := websocket.Dial(wctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// 1. hello for a thread with no events.
	writeJSONFrame(t, wctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	// 2. The thread must be auto-created, and that in turn must provision the
	// fake adapter via StartSession.
	var created *orchestration.Event
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && created == nil {
		f := readFrame(t, wctx, c)
		for i := range f.Events {
			if f.Events[i].Type == orchestration.EvtThreadCreated {
				ev := f.Events[i]
				created = &ev
			}
		}
	}
	if created == nil {
		t.Fatal("hello for a thread with no events never auto-created it")
	}
	var createdPayload struct {
		InstanceID string `json:"instanceId"`
	}
	if err := json.Unmarshal(created.Payload, &createdPayload); err != nil {
		t.Fatalf("decode thread.created payload: %v", err)
	}
	if createdPayload.InstanceID != "e2efake:default" {
		t.Fatalf("instanceId = %q, want e2efake:default", createdPayload.InstanceID)
	}
	e2eWaitFor(t, func() bool { return len(adapter.snapshotStartSessionCalls()) == 1 })

	// 3. Send thread.turn.start.
	writeJSONFrame(t, wctx, c, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-turn-1",
			Type:      orchestration.CmdThreadTurnStart,
			ThreadID:  threadID,
			Payload:   json.RawMessage(`{"text":"fix the auth redirect"}`),
		},
	})

	// 4. The fake adapter's SendTurn must receive it, carrying the mode from
	// thread state — not a hardcoded default the Reactor happened to pick.
	e2eWaitFor(t, func() bool { return len(adapter.snapshotSendTurnCalls()) == 1 })
	th, ok := engine.State().Thread(threadID)
	if !ok {
		t.Fatal("thread missing from engine state after turn.start")
	}
	turnCalls := adapter.snapshotSendTurnCalls()
	if turnCalls[0].ThreadID != threadID {
		t.Fatalf("SendTurn threadID = %q, want %q", turnCalls[0].ThreadID, threadID)
	}
	if turnCalls[0].Mode != th.Mode {
		t.Fatalf("SendTurn mode = %q, want thread state's mode %q", turnCalls[0].Mode, th.Mode)
	}

	// 5. Feed a ContentDelta and an ItemStarted (tool call) back through the
	// adapter's event channel, exactly as a real driver would forward parsed
	// provider output.
	adapter.ch <- event.Event{
		Type: event.ContentDelta, ThreadID: threadID, TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{
			ItemType: event.ItemAssistantMessage, Stream: event.StreamText,
			Text: "found the bug in the callback", Sequence: 1,
		},
	}
	adapter.ch <- event.Event{
		Type: event.ItemStarted, ThreadID: threadID, TurnID: "t1", ItemID: "i2",
		Payload: &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: "Read"},
	}

	// 6. Both must reach the client over the socket. The tool call is the one
	// Task 1 unblocked: ItemStarted falls through Ingestion's default branch
	// into CmdThreadActivityAppend, which had no decider rule until Task 1.
	sawDelta, sawToolCall := false, false
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !(sawDelta && sawToolCall) {
		f := readFrame(t, wctx, c)
		for _, e := range f.Events {
			if e.Type != orchestration.EvtThreadActivityAppended {
				continue
			}
			var probe struct {
				Type string `json:"type"` // set only on the wrapped raw-event payload (ItemStarted)
				Text string `json:"text"` // set only on the assistant-delta payload
			}
			_ = json.Unmarshal(e.Payload, &probe)
			switch {
			case probe.Type == string(event.ItemStarted):
				sawToolCall = true
			case probe.Text == "found the bug in the callback":
				sawDelta = true
			}
		}
	}
	if !sawDelta {
		t.Fatal("content delta never reached the client over the socket")
	}
	if !sawToolCall {
		t.Fatal("tool call (item.started) never reached the client — this is exactly what Task 1's decider rule unblocked")
	}
}
