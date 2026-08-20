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

	"nhooyr.io/websocket"
)

// The reported bug, reproduced end to end through every real layer between the
// agent process and the browser: process -> parseLine -> Ingestion -> engine ->
// durable log -> WebSocket.
//
// What the operator saw: a turn that went `running` then `idle` about two
// seconds later, `turnOutputTokens: 0`, an empty transcript, and no error of
// any kind. They sent the same message three times and got silence three
// times. The cause was a safeguard refusal — the CLI reported it, and DevDeck
// dropped it in two separate places (system subtypes other than "init", and
// TurnCompletedPayload.Status).
//
// The script below is that turn: the CLI's own `model_refusal_no_fallback`
// shape (snake_case on the stream-json wire, `content:""`, the "cyber" refusal
// category), followed by a terminal result with zero output tokens. Shapes are
// taken from the installed binary's emitters, not invented — see
// provider/claude/silentturn_test.go's header for the greps.
const refusedAgentScript = `#!/bin/sh
cat > /dev/null &
sleep 0.1
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake-session-uuid","model":"claude-sonnet-5"}'
printf '%s\n' '{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-sonnet-5","request_id":"req_1","api_refusal_category":"cyber","api_refusal_explanation":null,"refused_user_message_uuid":"u-1","content":"","session_id":"fake-session-uuid","uuid":"e-1"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"refusal","terminal_reason":"completed","result":"","session_id":"fake-session-uuid","usage":{"input_tokens":55965,"output_tokens":0}}'
sleep 5
`

func writeRefusingAgent(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "refusingclaude")
	if err := os.WriteFile(path, []byte(refusedAgentScript), 0o700); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	return path
}

func TestSilentTurnReachesTheClientAsAVisibleError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake agent is a /bin/sh script")
	}

	st, threadID := newSmokeStore(t)
	binPath := writeRefusingAgent(t)

	// A counter, not a clock — see agent_smoke_test.go's own NewID comment for
	// the collision this avoids.
	eventSeq := 0
	engine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { eventSeq++; return "ae-" + strconv.Itoa(eventSeq) },
		QueueSize: 64,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)

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

	svc := &provider.Service{Registry: registry, Dir: orchestration.NewThreadDirectory()}
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
			return provider.InstanceID("claude:default"), provider.SessionStartInput{ThreadID: threadID, Cwd: wt.Path}, nil
		},
	}
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
	defer c.CloseNow()

	writeJSONFrame(t, wctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	mu := make(chan struct{}, 1)
	var received []orchestration.Event
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
			Payload:   json.RawMessage(`{"text":"di kubernetes yg paling banyak pakai ram dan cpu apa?"}`),
		},
	})

	// The assertion the whole change exists for: a REASON, on the wire, that
	// the client can render. Before the fix this turn produced exactly one
	// thread.session-set with status idle and nothing else.
	smokeWaitFor(t, "a runtime.error carrying the refusal reason", func() bool {
		for _, e := range snapshot() {
			if e.Type != orchestration.EvtThreadActivityAppended {
				continue
			}
			p := string(e.Payload)
			if strings.Contains(p, "runtime.error") && strings.Contains(p, "cyber") {
				return true
			}
		}
		return false
	})

	// And the turn must still settle: reporting a reason while leaving the
	// composer stuck on "Stop" would trade a silent turn for a frozen one.
	smokeWaitFor(t, "the thread to settle back to idle", func() bool {
		for _, e := range snapshot() {
			if e.Type == orchestration.EvtThreadSessionSet && strings.Contains(string(e.Payload), `"status":"idle"`) {
				return true
			}
		}
		return false
	})
}
