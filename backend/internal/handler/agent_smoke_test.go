package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/agentcore/provider/claude"
	"devdeck/backend/internal/store"

	"nhooyr.io/websocket"
)

// The seam test one layer deeper than agent_ws_e2e_test.go.
//
// That test stops at a fake *adapter*, so it never touches the three pieces
// that actually broke in practice: spawning a process, the args buildArgs
// produces, and parseLine turning real NDJSON back into canonical events.
// Every defect this feature shipped lived between layers, not inside one, and
// each was invisible to a suite where every test asserted a single layer.
//
// So this drives the REAL claude driver and adapter against a fake agent
// *binary* — a script emitting genuine stream-json — and asserts that a
// user's message and a tool call both come back out of the WebSocket.
//
// Deliberately not asserting on the real `claude` CLI: that would need a
// logged-in machine and would make the suite depend on a third party's output
// format. The script's shapes are copied from testdata/turn.ndjson.

const fakeAgentScript = `#!/bin/sh
# Emits a minimal but real stream-json turn: session init, an assistant text
# delta, a tool_use block, then the terminal result. Reads and discards stdin
# so the adapter's write side is exercised too.
cat > /dev/null &
sleep 0.1
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake-session-uuid","model":"claude-sonnet-5"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I found the bug"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'
printf '%s\n' '{"type":"result","subtype":"success","session_id":"fake-session-uuid","usage":{"input_tokens":10,"output_tokens":5}}'
sleep 5
`

func writeFakeAgent(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fakeclaude")
	if err := os.WriteFile(path, []byte(fakeAgentScript), 0o700); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	return path
}

func smokeWaitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAgentSmokeRealProcessReachesTheClient(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake agent is a /bin/sh script")
	}

	st, threadID := newSmokeStore(t)
	binPath := writeFakeAgent(t)

	// A counter, like every sibling test's NewID — NOT a clock reading.
	//
	// This was `"ae-" + strconv.Itoa(time.Now().Nanosecond())`, which is not
	// unique: macOS reports that clock at microsecond granularity (ids came
	// out ending in "000"), and Decide mints two ids back to back for a single
	// turn.start — well inside one tick. When they collided the whole commit
	// failed on agent_event.event_id's UNIQUE constraint, the turn was
	// rejected, and the test timed out waiting for a message that was never
	// logged. Intermittent by nature, and it blamed whatever unrelated change
	// happened to shift the timing.
	//
	// Safe unsynchronized: Engine.process is the only caller and it runs on the
	// engine's single goroutine.
	eventSeq := 0
	engine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { eventSeq++; return "ae-" + strconv.Itoa(eventSeq) },
		QueueSize: 64,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)

	// The REAL driver, pointed at the fake binary. Started up front with an
	// explicit config because ensureInstanceStarted builds its own from
	// DefaultConfig(), which hardcodes "claude" — pre-starting is also what
	// its Adapter(id) pre-check is there to detect.
	registry := provider.NewRegistry(claude.NewDriver())
	d, _ := registry.Driver("claude")
	cfg, err := d.DecodeConfig(json.RawMessage(`{"binaryName":` + strconv.Quote(binPath) + `}`))
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	adapter, err := registry.StartInstance(ctx, "claude", provider.InstanceSpec{
		InstanceID: "claude:default", DisplayName: "claude", Config: cfg, Enabled: true,
	})
	if err != nil {
		t.Fatalf("start instance: %v", err)
	}

	dir := orchestration.NewThreadDirectory()
	svc := &provider.Service{Registry: registry, Dir: dir}

	idSeq := 0
	ingestion := orchestration.NewIngestion(engine, approval.NoopBroker{}, func() string {
		idSeq++
		return "ac-in-" + strconv.Itoa(idSeq)
	})
	go ingestion.Consume(ctx, adapter)

	reactor := &orchestration.Reactor{
		Engine: engine, Provider: svc, Broker: approval.NoopBroker{},
		InstanceFor: func(threadID string) (provider.InstanceID, provider.SessionStartInput, error) {
			wt, err := st.WorktreeByID(threadID)
			if err != nil {
				return "", provider.SessionStartInput{}, err
			}
			return provider.InstanceID("claude:default"), provider.SessionStartInput{
				ThreadID: threadID,
				Cwd:      wt.Path,
			}, nil
		},
	}
	// Start, not `go Run`: Engine.publish only reaches subscribers that exist
	// at publish time, so `go Run` can miss the very first command.
	reactor.Start(ctx)

	h := NewAgentWSHandler(engine, st, svc)
	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()

	wctx, wcancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer wcancel()

	c, _, err := websocket.Dial(wctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, wctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	// Collect frames on a goroutine so the assertions below can poll what has
	// arrived so far without blocking on a read that may never come.
	var (
		mu       = make(chan struct{}, 1)
		received []orchestration.Event
	)
	mu <- struct{}{}
	go func() {
		for {
			f := readFrameOrNil(wctx, c)
			if f == nil {
				return
			}
			<-mu
			received = append(received, f.Events...)
			mu <- struct{}{}
		}
	}()

	snapshot := func() []orchestration.Event {
		<-mu
		out := append([]orchestration.Event(nil), received...)
		mu <- struct{}{}
		return out
	}

	smokeWaitFor(t, "thread auto-create", func() bool {
		for _, e := range snapshot() {
			if e.Type == orchestration.EvtThreadCreated {
				return true
			}
		}
		return false
	})

	writeJSONFrame(t, wctx, c, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-turn-1",
			Type:      orchestration.CmdThreadTurnStart,
			ThreadID:  threadID,
			Payload:   json.RawMessage(`{"text":"fix the auth redirect"}`),
		},
	})

	// The user's own message. This never rendered in the shipped app because
	// the frontend reducer dropped this payload shape — asserting it is on the
	// wire keeps the backend half honest regardless.
	smokeWaitFor(t, "the user's message on the wire", func() bool {
		for _, e := range snapshot() {
			if e.Type == orchestration.EvtThreadMessageSent && strings.Contains(string(e.Payload), "fix the auth redirect") {
				return true
			}
		}
		return false
	})

	// Assistant text, having gone out to a real process and back through
	// parseLine. This is the hop the fake-adapter e2e test cannot cover.
	smokeWaitFor(t, "assistant text from the agent process", func() bool {
		for _, e := range snapshot() {
			if e.Type == orchestration.EvtThreadActivityAppended && strings.Contains(string(e.Payload), "I found the bug") {
				return true
			}
		}
		return false
	})

	// A tool call. This one reaches the client only through Ingestion's
	// fallback, which dispatches CmdThreadActivityAppend — the command that
	// had no decider rule and silently swallowed every tool call.
	smokeWaitFor(t, "a tool call to reach the client", func() bool {
		for _, e := range snapshot() {
			if e.Type != orchestration.EvtThreadActivityAppended {
				continue
			}
			p := string(e.Payload)
			if strings.Contains(p, "tool_call") || strings.Contains(p, "\"Read\"") {
				return true
			}
		}
		return false
	})
}

// newSmokeStore builds a real SQLite store with one root worktree, mirroring
// newAgentWSTestEnv's setup but leaving engine construction to the caller.
func newSmokeStore(t *testing.T) (*store.Store, string) {
	t.Helper()

	db, err := store.Open(filepath.Join(t.TempDir(), "smoke.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st := store.New(db)

	workspace, err := st.CreateWorkspace("Workspace")
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	project, err := st.CreateProject(workspace.ID, "Project", t.TempDir(), "", "")
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	wt, err := st.CreateWorktree(project.ID, "root", "", "", "", "claude", "", t.TempDir())
	if err != nil {
		t.Fatalf("create worktree: %v", err)
	}
	return st, wt.ID
}

// readFrameOrNil is readFrame's non-fatal twin: the collector goroutine below
// cannot call t.Fatal, and a closed socket at test teardown is expected.
func readFrameOrNil(ctx context.Context, c *websocket.Conn) *wsFrame {
	_, data, err := c.Read(ctx)
	if err != nil {
		return nil
	}
	var f wsFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil
	}
	return &f
}
