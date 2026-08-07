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
	"devdeck/backend/internal/store"

	"nhooyr.io/websocket"
)

type wsFrame struct {
	Kind   string                `json:"kind"`
	Events []orchestration.Event `json:"events,omitempty"`
	Error  string                `json:"error,omitempty"`
}

// newTestAgentWS builds a handler wired to a temp-file SQLite store (matching
// the pattern in internal/store's own tests) and an engine running on
// orchestration.NewPortStore(st). The registry is deliberately empty — these
// tests exercise the socket protocol, not a live provider.
func newTestAgentWS(t *testing.T) (*AgentWSHandler, func()) {
	t.Helper()

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st := store.New(db)

	n := 0
	engine := orchestration.NewEngine(orchestration.EngineOptions{
		Store: orchestration.NewPortStore(st),
		NewID: func() string { n++; return "ae-" + strconv.Itoa(n) },
	})

	ctx, cancel := context.WithCancel(context.Background())
	go engine.Run(ctx)

	registry := provider.NewRegistry()
	svc := &provider.Service{Registry: registry, Dir: orchestration.NewThreadDirectory()}

	h := NewAgentWSHandler(engine, st, svc)
	cleanup := func() {
		cancel()
		_ = db.Close()
	}
	return h, cleanup
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
func TestReplayFromSeqIsExact(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
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

	writeJSONFrame(t, ctx, c1, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c1, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
			Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
		},
	})

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
		t.Fatal("no events arrived on the socket")
	}
	c1.Close(websocket.StatusNormalClosure, "")

	// Reconnect reporting what we already have; we must get nothing back.
	c2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("redial: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c2, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": lastSeq})

	shortCtx, shortCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer shortCancel()
	if _, _, err := c2.Read(shortCtx); err == nil {
		t.Fatal("client already at head must receive no replay")
	}
}

// A client that reconnects and resends the same CommandID must not start a
// second turn. Mobile clients do this constantly.
func TestResendingCommandIDIsIdempotentOverTheSocket(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
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
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
	}
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})

	time.Sleep(300 * time.Millisecond)

	logged, err := h.store.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(logged) != 1 {
		t.Fatalf("log has %d events, want 1 — a resent CommandID must not append", len(logged))
	}
}

// A client must not be able to forge agent output.
func TestServerOnlyCommandRejected(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
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

	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-forge", Type: orchestration.CmdThreadAssistantDelta, ThreadID: "w-abc",
			Payload: json.RawMessage(`{"text":"I am the agent"}`),
		},
	})

	f := readFrame(t, ctx, c)
	if f.Kind != "error" {
		t.Fatalf("frame kind = %s, want error for a server-only command", f.Kind)
	}
}
