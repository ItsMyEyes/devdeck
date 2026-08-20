package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// newTestAdapter builds an adapter with its stdin wired to buf instead of a
// real process — enough to exercise dispatchServerRequest/RespondToRequest's
// wire-writing without spawning `codex app-server`.
func newTestAdapter(buf *bytes.Buffer) *adapter {
	a := &adapter{
		instanceID: "codex:default",
		events:     make(chan event.Event, 16),
		sessions:   map[string]*session{},
		byCodex:    map[string]*session{},
		pending:    map[int64]chan rpcResult{},
	}
	a.stdinEn = json.NewEncoder(buf)
	return a
}

func newTestSession(devdeckThreadID, codexThreadID string) *session {
	return &session{
		threadID: devdeckThreadID,
		codexID:  codexThreadID,
		state:    newParseState(devdeckThreadID, codexThreadID, "codex:default"),
	}
}

// This is the exact bug: before dispatchServerRequest existed, a
// server->client REQUEST (id + method both present) was routed into
// dispatchNotification, which has no reply mechanism at all — the
// app-server sat blocked on the turn forever. Asserting a reply IS written,
// synchronously, closes that gap directly.
func TestDispatchServerRequestOpensACardAndWritesNoReplyUntilAnswered(t *testing.T) {
	var buf bytes.Buffer
	a := newTestAdapter(&buf)
	s := newTestSession("w-1", "cx-1")
	a.sessions["w-1"] = s
	a.byCodex["cx-1"] = s

	line := []byte(`{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval",` +
		`"params":{"threadId":"cx-1","turnId":"t-1","itemId":"i-1","command":"echo hi","startedAtMs":1787028744000}}`)
	a.dispatchServerRequest(line, json.RawMessage(`7`), "item/commandExecution/requestApproval")

	if buf.Len() != 0 {
		t.Fatalf("a recognised approval must wait for a real decision, not reply immediately; wrote: %s", buf.String())
	}

	select {
	case e := <-a.events:
		if e.Type != event.RequestOpened {
			t.Fatalf("event type = %s, want request.opened", e.Type)
		}
		if e.RequestID == "" {
			t.Fatal("RequestID must be set")
		}
		if err := a.RespondToRequest(context.Background(), "w-1", e.RequestID, event.DecisionAccept); err != nil {
			t.Fatalf("RespondToRequest: %v", err)
		}
	default:
		t.Fatal("dispatchServerRequest must emit a request.opened event")
	}

	var reply struct {
		ID     int64 `json:"id"`
		Result struct {
			Decision string `json:"decision"`
		} `json:"result"`
	}
	if err := json.Unmarshal(buf.Bytes(), &reply); err != nil {
		t.Fatalf("reply is not valid JSON: %v (%s)", err, buf.String())
	}
	if reply.ID != 7 {
		t.Fatalf("reply id = %d, want 7 echoed back", reply.ID)
	}
	if reply.Result.Decision != "accept" {
		t.Fatalf("reply decision = %q, want accept", reply.Result.Decision)
	}
}

// A method with no approval card (here, the experimental
// item/tool/requestUserInput) must still unblock the app-server: a JSON-RPC
// error reply, written synchronously, rather than the pre-fix silence.
func TestDispatchServerRequestAutoDeclinesUnhandledMethods(t *testing.T) {
	var buf bytes.Buffer
	a := newTestAdapter(&buf)
	s := newTestSession("w-1", "cx-1")
	a.sessions["w-1"] = s
	a.byCodex["cx-1"] = s

	line := []byte(`{"jsonrpc":"2.0","id":3,"method":"item/tool/requestUserInput",` +
		`"params":{"threadId":"cx-1","turnId":"t-1","itemId":"i-2","questions":[]}}`)
	a.dispatchServerRequest(line, json.RawMessage(`3`), "item/tool/requestUserInput")

	var reply struct {
		ID    int64 `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(buf.Bytes(), &reply); err != nil {
		t.Fatalf("reply is not valid JSON: %v (%s)", err, buf.String())
	}
	if reply.ID != 3 || reply.Error == nil {
		t.Fatalf("reply = %+v, want an error reply echoing id 3", reply)
	}

	select {
	case e := <-a.events:
		if e.Type != event.RuntimeWarning {
			t.Fatalf("event type = %s, want runtime.warning for visibility", e.Type)
		}
	default:
		t.Fatal("an auto-declined request must still surface a warning")
	}
}

// A request naming a thread this adapter has already forgotten (session
// exited, or the id is stale) has nobody to raise a card for — the only
// sound answer is an immediate decline, not silence.
func TestDispatchServerRequestDeclinesWhenNoSessionMatches(t *testing.T) {
	var buf bytes.Buffer
	a := newTestAdapter(&buf)

	line := []byte(`{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval",` +
		`"params":{"threadId":"cx-unknown","turnId":"t-1","itemId":"i-1","command":"echo hi","startedAtMs":1}}`)
	a.dispatchServerRequest(line, json.RawMessage(`9`), "item/commandExecution/requestApproval")

	var reply struct {
		ID    int64                     `json:"id"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(buf.Bytes(), &reply); err != nil {
		t.Fatalf("reply is not valid JSON: %v (%s)", err, buf.String())
	}
	if reply.ID != 9 || reply.Error == nil {
		t.Fatalf("reply = %+v, want an immediate error decline", reply)
	}
}

var _ provider.Adapter = (*adapter)(nil)
