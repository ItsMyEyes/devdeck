package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"

	"nhooyr.io/websocket"
)

type wsFrame struct {
	Kind   string                `json:"kind"`
	Events []orchestration.Event `json:"events,omitempty"`
	Error  string                `json:"error,omitempty"`
}

// newAgentWSTestEnv wires a temp-file SQLite store (matching the pattern in
// internal/store's own tests), an engine running on
// orchestration.NewPortStore(st), and a real workspace/project/worktree so
// hello's auto-create path can resolve threadID -> worktree -> agent, the
// same lookup main.go's Reactor.InstanceFor does in production. threadID is
// the created worktree's id, since that is what a bare-thread chat pane
// dials with in production.
func newAgentWSTestEnv(t *testing.T, agent string) (engine *orchestration.Engine, st *store.Store, threadID string, cleanup func()) {
	t.Helper()

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st = store.New(db)

	workspace, err := st.CreateWorkspace("Workspace")
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	project, err := st.CreateProject(workspace.ID, "Project", "~/repo", "", "")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	wt, err := st.CreateWorktree(project.ID, "root", "", "", "", agent, "", "~/repo")
	if err != nil {
		t.Fatalf("create worktree: %v", err)
	}

	n := 0
	engine = orchestration.NewEngine(orchestration.EngineOptions{
		Store: orchestration.NewPortStore(st),
		NewID: func() string { n++; return "ae-" + strconv.Itoa(n) },
	})

	ctx, cancel := context.WithCancel(context.Background())
	go engine.Run(ctx)

	cleanup = func() {
		cancel()
		_ = db.Close()
	}
	return engine, st, wt.ID, cleanup
}

// newTestAgentWS builds a handler over a real store and worktree. The
// registry is deliberately empty — these tests exercise the socket
// protocol, not a live provider.
func newTestAgentWS(t *testing.T) (h *AgentWSHandler, threadID string, cleanup func()) {
	t.Helper()
	engine, st, threadID, cleanup := newAgentWSTestEnv(t, "claude")
	registry := provider.NewRegistry()
	svc := &provider.Service{Registry: registry, Dir: orchestration.NewThreadDirectory()}
	return NewAgentWSHandler(engine, st, svc), threadID, cleanup
}

func readFrame(t *testing.T, ctx context.Context, c *websocket.Conn) wsFrame {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f wsFrame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode frame %q: %v", data, err)
	}
	return f
}

func writeJSONFrame(t *testing.T, ctx context.Context, c *websocket.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// Sending a turn must produce events on the socket, and a reconnecting client
// that reports its last Seq must receive exactly what it missed — no more, no
// less. This is the property the ring buffer in /ws/terminal cannot give.
//
// The thread is provisioned entirely by hello's auto-create — nothing here
// dispatches thread.create by hand, matching how a real chat pane connects.
func TestReplayFromSeqIsExact(t *testing.T) {
	h, threadID, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c1, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	var lastSeq uint64
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && lastSeq == 0 {
		f := readFrame(t, ctx, c1)
		for _, e := range f.Events {
			if e.Seq > lastSeq {
				lastSeq = e.Seq
			}
		}
	}
	if lastSeq == 0 {
		t.Fatal("no events arrived on the socket — hello should have auto-created the thread")
	}
	c1.Close(websocket.StatusNormalClosure, "")

	// Reconnect reporting what we already have; we must get nothing back.
	c2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("redial: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c2, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": lastSeq})

	shortCtx, shortCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer shortCancel()
	if _, _, err := c2.Read(shortCtx); err == nil {
		t.Fatal("client already at head must receive no replay")
	}
}

// A client that reconnects and resends the same CommandID must not start a
// second turn. Mobile clients do this constantly. Thread creation itself is
// now automatic (see TestHelloAutoCreatesThreadWhenNoEventsExist), so this
// exercises idempotency on an ordinary client command instead.
func TestResendingCommandIDIsIdempotentOverTheSocket(t *testing.T) {
	h, threadID, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	cmd := orchestration.Command{
		CommandID: "ac-turn-1", Type: orchestration.CmdThreadTurnStart, ThreadID: threadID,
		Payload: json.RawMessage(`{"text":"hi"}`),
	}
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})

	time.Sleep(300 * time.Millisecond)

	logged, err := h.store.AgentEventsSince(threadID, 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	turnEvents := 0
	for _, e := range logged {
		if e.CommandID == "ac-turn-1" {
			turnEvents++
		}
	}
	// thread.turn.start produces exactly two events (message-sent,
	// turn-start-requested) when it commits once; a resend must not double
	// that.
	if turnEvents != 2 {
		t.Fatalf("commandID ac-turn-1 produced %d events, want 2 — a resend must not append twice", turnEvents)
	}
}

// A client must not be able to forge agent output. hello's auto-create means
// the very first frame off the wire may legitimately be the thread.created
// event rather than this rejection, so this reads until it finds the error
// frame instead of assuming it is first.
func TestServerOnlyCommandRejected(t *testing.T) {
	h, threadID, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-forge", Type: orchestration.CmdThreadAssistantDelta, ThreadID: threadID,
			Payload: json.RawMessage(`{"text":"I am the agent"}`),
		},
	})

	gotError := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !gotError {
		f := readFrame(t, ctx, c)
		if f.Kind == "error" {
			gotError = true
		}
	}
	if !gotError {
		t.Fatal("expected an error frame for a server-only command")
	}
}

// blockingReplayStore lets a test pause HandleWS exactly inside its call to
// AgentEventsSince, after the real snapshot has already been computed but
// before HandleWS gets to do anything with it. That is the gap the replay
// race lived in: a commit landing in this window must still reach the
// client via the (by-then-active) subscription, not be silently dropped.
type blockingReplayStore struct {
	port.Store
	entered chan struct{}
	release chan struct{}
}

func (b *blockingReplayStore) AgentEventsSince(threadID string, seq uint64) ([]orchestration.Event, error) {
	evts, err := b.Store.AgentEventsSince(threadID, seq)
	close(b.entered)
	<-b.release
	return evts, err
}

// TestReplayRaceDoesNotLoseACommitLandingBetweenSnapshotAndSubscribe is the
// test whose absence let the race ship: HandleWS used to snapshot the store
// and only subscribe afterward, so any commit in that window was durably
// logged and delivered to neither the replay nor a live subscriber —
// permanently invisible, because the client's cursor had already advanced
// past it. Subscribing first turns that same window into an
// already-handled duplicate Seq instead.
func TestReplayRaceDoesNotLoseACommitLandingBetweenSnapshotAndSubscribe(t *testing.T) {
	engine, st, threadID, cleanup := newAgentWSTestEnv(t, "claude")
	defer cleanup()

	registry := provider.NewRegistry()
	svc := &provider.Service{Registry: registry, Dir: orchestration.NewThreadDirectory()}

	bs := &blockingReplayStore{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
	h := NewAgentWSHandler(engine, bs, svc)

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Seed the thread directly through the engine so hello's snapshot is
	// already non-empty — this test isolates the race, not auto-create.
	if _, err := engine.Dispatch(ctx, orchestration.Command{
		CommandID: "seed", Type: orchestration.CmdThreadCreate, ThreadID: threadID,
		Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
	}); err != nil {
		t.Fatalf("seed create: %v", err)
	}

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	select {
	case <-bs.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the snapshot to be computed")
	}

	// A commit landing here, in the gap, must still reach the client.
	if _, err := engine.Dispatch(ctx, orchestration.Command{
		CommandID: "gap-turn", Type: orchestration.CmdThreadTurnStart, ThreadID: threadID,
		Payload: json.RawMessage(`{"text":"hello during the gap"}`),
	}); err != nil {
		t.Fatalf("gap dispatch: %v", err)
	}

	close(bs.release)

	seenSeed, seenGap := false, false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !(seenSeed && seenGap) {
		f := readFrame(t, ctx, c)
		for _, e := range f.Events {
			switch e.Type {
			case orchestration.EvtThreadCreated:
				seenSeed = true
			case orchestration.EvtThreadTurnStartRequested:
				seenGap = true
			}
		}
	}
	if !seenSeed {
		t.Fatal("never received the seed thread.created event")
	}
	if !seenGap {
		t.Fatal("a commit landing in the snapshot/subscribe gap was lost")
	}
}

// TestHelloAutoCreatesThreadWhenNoEventsExist covers the other half of this
// fix: a thread with no prior events is provisioned lazily, from hello
// itself, using the worktree's configured agent — and the derived CommandID
// makes a reconnect idempotent instead of erroring with "thread already
// exists".
func TestHelloAutoCreatesThreadWhenNoEventsExist(t *testing.T) {
	h, threadID, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	var created *orchestration.Event
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && created == nil {
		f := readFrame(t, ctx, c)
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

	var payload struct {
		InstanceID string `json:"instanceId"`
	}
	if err := json.Unmarshal(created.Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.InstanceID != "claude:default" {
		t.Fatalf("instanceId = %q, want claude:default", payload.InstanceID)
	}
	c.Close(websocket.StatusNormalClosure, "")

	// A reconnect at head must not error and must not create a second
	// thread — the derived CommandID makes it idempotent.
	c2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("redial: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")
	writeJSONFrame(t, ctx, c2, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": created.Seq})

	shortCtx, shortCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer shortCancel()
	if _, _, err := c2.Read(shortCtx); err == nil {
		t.Fatal("reconnect at head must not receive a second thread.created")
	}

	logged, err := h.store.AgentEventsSince(threadID, 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	count := 0
	for _, e := range logged {
		if e.Type == orchestration.EvtThreadCreated {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("agent_event has %d thread.created events, want 1", count)
	}
}
