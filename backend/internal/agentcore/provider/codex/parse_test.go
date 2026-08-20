package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// The fixture is REAL traffic: it was captured from `codex app-server`
// 0.145.0 driven through initialize -> thread/start -> turn/start, not
// hand-written from the schema. A hand-written fixture only proves the parser
// agrees with whoever wrote it.
func parseFixture(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	st := newParseState("w-abc", "01a00e0b-f8c1-7450-80ad-5dd089e05e3d", "codex:default")
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		// The adapter hands the parser `params`; do the same here so the test
		// exercises the real boundary.
		var wrapper struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(line, &wrapper); err != nil {
			t.Fatalf("fixture line is not JSON: %v", err)
		}
		full, _ := json.Marshal(map[string]any{"method": wrapper.Method, "params": wrapper.Params})
		out = append(out, parseNotification(full, st)...)
	}
	return out
}

func TestFixtureProducesATurnLifecycle(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")

	var started, completed bool
	for _, e := range evts {
		switch e.Type {
		case event.TurnStarted:
			started = true
		case event.TurnCompleted:
			completed = true
		}
	}
	if !started {
		t.Fatalf("no turn.started; got %+v", kinds(evts))
	}
	if !completed {
		t.Fatalf("no turn.completed; got %+v", kinds(evts))
	}
}

// The user's own message is already in the transcript by the time the server
// echoes it back — rendering it again would double every message typed.
func TestUserMessageItemsAreNotEchoed(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")
	for _, e := range evts {
		if p, ok := e.Payload.(*event.ItemStartedPayload); ok && p.ItemType == event.ItemUserMessage {
			t.Fatal("the user's own message was echoed back into the transcript")
		}
		if p, ok := e.Payload.(*event.ItemCompletedPayload); ok && p.ItemType == event.ItemUserMessage {
			t.Fatal("the user's own message was echoed back into the transcript")
		}
	}
}

// A transient `error` notification ("Reconnecting... 1/5") was captured mid-turn
// and the turn still completed. Treating one as fatal would kill turns that go
// on to succeed.
func TestTransientErrorIsAWarningNotASessionEnd(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")
	for _, e := range evts {
		if e.Type == event.SessionExited {
			t.Fatal("a mid-turn error must not end the session")
		}
	}
	var warned bool
	for _, e := range evts {
		if e.Type == event.RuntimeWarning {
			warned = true
			if e.Raw == nil || len(e.Raw.Payload) == 0 {
				t.Fatal("a warning must carry Raw for debugging")
			}
		}
	}
	if !warned {
		t.Fatalf("the captured error should surface as a warning; got %+v", kinds(evts))
	}
}

// Params shapes below are lifted verbatim from a live
// `codex app-server generate-json-schema` run against the installed 0.145.0
// binary (CommandExecutionRequestApprovalParams / FileChangeRequestApprovalParams),
// not hand-guessed — matching this package's own "verified, not guessed" bar.

func TestCommandExecutionApprovalOpensARequestAndRegistersPending(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	params := []byte(`{"threadId":"cx-1","turnId":"t-1","itemId":"i-1","command":"rm -rf /tmp/scratch","startedAtMs":1787028744000}`)

	evts, autoDecline := parseServerRequest(json.RawMessage(`7`), "item/commandExecution/requestApproval", params, st)
	if autoDecline {
		t.Fatal("a recognised approval method must not be auto-declined")
	}
	if len(evts) != 1 || evts[0].Type != event.RequestOpened {
		t.Fatalf("events = %+v, want one request.opened", kinds(evts))
	}
	p, ok := evts[0].Payload.(*event.RequestOpenedPayload)
	if !ok || p.RequestType != event.ReqCommandExecApproval {
		t.Fatalf("payload = %+v, want command exec approval", evts[0].Payload)
	}
	if evts[0].RequestID == "" {
		t.Fatal("RequestID must be set — it's what RespondToRequest looks the pending entry up by")
	}

	pending, found := st.takePending(evts[0].RequestID)
	if !found {
		t.Fatal("a real approval request must be registered as pending so a later decision can answer it")
	}
	if pending.method != "item/commandExecution/requestApproval" || string(pending.rpcID) != "7" {
		t.Fatalf("pending = %+v, want the original method and rpc id preserved", pending)
	}

	if _, found := st.takePending(evts[0].RequestID); found {
		t.Fatal("takePending must retire the entry — a second answer to the same request would be a stale reply")
	}
}

func TestFileChangeApprovalOpensARequestAndRegistersPending(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	params := []byte(`{"threadId":"cx-1","turnId":"t-1","itemId":"i-2","startedAtMs":1787028744000,"reason":"writes outside the workspace root"}`)

	evts, autoDecline := parseServerRequest(json.RawMessage(`"req-9"`), "item/fileChange/requestApproval", params, st)
	if autoDecline {
		t.Fatal("a recognised approval method must not be auto-declined")
	}
	if len(evts) != 1 || evts[0].Type != event.RequestOpened {
		t.Fatalf("events = %+v, want one request.opened", kinds(evts))
	}
	p := evts[0].Payload.(*event.RequestOpenedPayload)
	if p.RequestType != event.ReqFileChangeApproval {
		t.Fatalf("requestType = %q, want file change approval", p.RequestType)
	}

	pending, found := st.takePending(evts[0].RequestID)
	if !found || pending.method != "item/fileChange/requestApproval" {
		t.Fatalf("pending = %+v, found=%v", pending, found)
	}
	// A string rpc id must round-trip through rpcIDKey and back into the
	// pending entry's rpcID WITHOUT losing its JSON string-ness — replying
	// with a bare `req-9` instead of `"req-9"` would be a malformed
	// JSON-RPC id the app-server can't correlate.
	if string(pending.rpcID) != `"req-9"` {
		t.Fatalf("rpcID = %s, want the original quoted JSON string preserved", pending.rpcID)
	}
}

// A method this file has no UI for yet (here, the EXPERIMENTAL
// item/tool/requestUserInput, whose answers-keyed-by-question-id echo
// contract is unverified against a live capture) must be auto-declined
// immediately rather than left for the app-server to wait on forever — the
// exact bug this file exists to close.
func TestUnhandledServerRequestIsAutoDeclinedNotIgnored(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	params := []byte(`{"threadId":"cx-1","turnId":"t-1","itemId":"i-3","questions":[]}`)

	evts, autoDecline := parseServerRequest(json.RawMessage(`3`), "item/tool/requestUserInput", params, st)
	if !autoDecline {
		t.Fatal("an unimplemented request method must be auto-declined, not left hanging")
	}
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want a visible warning", kinds(evts))
	}
}

func TestRPCIDKeyUnwrapsJSONStringsAndKeepsNumbersLiteral(t *testing.T) {
	if got := rpcIDKey(json.RawMessage(`"abc"`)); got != "abc" {
		t.Fatalf("string id = %q, want unwrapped", got)
	}
	if got := rpcIDKey(json.RawMessage(`42`)); got != "42" {
		t.Fatalf("number id = %q, want literal text", got)
	}
}

// Regression: turn/completed used to hardcode Status:"completed" and
// silently discarded Turn.status, so a turn the app-server itself reported
// as "failed" (per the live fixture, line 10 of testdata/turn.ndjson)
// reached every consumer of TurnCompletedPayload labelled as a success.
func TestTurnCompletedReflectsAFailedTurnStatus(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	line := []byte(`{"method":"turn/completed","params":{"threadId":"cx-1","turn":{"id":"t-1","status":"failed",` +
		`"error":{"message":"stream disconnected before completion"}}}}`)

	evts := parseNotification(line, st)
	if len(evts) != 1 || evts[0].Type != event.TurnCompleted {
		t.Fatalf("events = %+v", kinds(evts))
	}
	p := evts[0].Payload.(*event.TurnCompletedPayload)
	if p.Status != "failed" {
		t.Fatalf("status = %q, want failed", p.Status)
	}
}

func TestAgentMessageDeltaBecomesTextContent(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	line := []byte(`{"method":"item/agentMessage/delta","params":{"delta":"hel","itemId":"i-1","threadId":"cx-1","turnId":"t-1"}}`)

	evts := parseNotification(line, st)
	if len(evts) != 1 || evts[0].Type != event.ContentDelta {
		t.Fatalf("events = %+v, want one content.delta", kinds(evts))
	}
	p := evts[0].Payload.(*event.ContentDeltaPayload)
	if p.Stream != event.StreamText || p.Text != "hel" {
		t.Fatalf("payload = %+v", p)
	}
	if evts[0].ItemID != "i-1" {
		t.Fatalf("itemID = %q, want the delta's own item", evts[0].ItemID)
	}
	// Sequence is what lets the client detect a dropped delta; it must advance.
	second := parseNotification(line, st)
	if second[0].Payload.(*event.ContentDeltaPayload).Sequence != 2 {
		t.Fatalf("sequence did not advance: %+v", second[0].Payload)
	}
}

// Codex splits reasoning into a raw stream and a summary stream. Both are
// reasoning in the transcript, so both must land on the one canonical stream
// rather than one of them silently becoming assistant text.
func TestBothReasoningStreamsFoldIntoReasoning(t *testing.T) {
	for _, method := range []string{"item/reasoning/textDelta", "item/reasoning/summaryTextDelta"} {
		st := newParseState("w-abc", "cx-1", "codex:default")
		line := []byte(`{"method":"` + method + `","params":{"delta":"thinking","itemId":"i-1","threadId":"cx-1","turnId":"t-1","contentIndex":0}}`)
		evts := parseNotification(line, st)
		if len(evts) != 1 {
			t.Fatalf("%s: events = %+v", method, kinds(evts))
		}
		p := evts[0].Payload.(*event.ContentDeltaPayload)
		if p.Stream != event.StreamReasoning {
			t.Fatalf("%s: stream = %q, want reasoning", method, p.Stream)
		}
	}
}

// The distinction this parser draws: a method it knows about and skips is
// silence, a method it has never seen is a warning carrying Raw. Collapsing
// the two is how a protocol change goes unnoticed for a release.
func TestKnownNoiseIsSilentAndUnknownMethodsWarn(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")

	if evts := parseNotification([]byte(`{"method":"thread/tokenUsage/updated","params":{"threadId":"cx-1"}}`), st); len(evts) != 0 {
		t.Fatalf("known noise produced events: %+v", kinds(evts))
	}

	evts := parseNotification([]byte(`{"method":"turn/somethingBrandNew","params":{"threadId":"cx-1"}}`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("unknown method must warn; got %+v", kinds(evts))
	}
}

func TestTurnCompletedCarriesUsageWhenReported(t *testing.T) {
	st := newParseState("w-abc", "cx-1", "codex:default")
	line := []byte(`{"method":"turn/completed","params":{"threadId":"cx-1","turn":{"id":"t-1","status":"completed",` +
		`"usage":{"inputTokens":100,"cachedInputTokens":40,"outputTokens":25,"contextWindow":272000}}}}`)

	evts := parseNotification(line, st)
	if len(evts) != 1 || evts[0].Type != event.TurnCompleted {
		t.Fatalf("events = %+v", kinds(evts))
	}
	p := evts[0].Payload.(*event.TurnCompletedPayload)
	if p.Usage == nil {
		t.Fatal("usage must survive — the transcript's per-turn cost comes from it")
	}
	if p.Usage.InputTokens != 100 || p.Usage.OutputTokens != 25 || p.Usage.CacheReadTokens != 40 {
		t.Fatalf("usage = %+v", p.Usage)
	}
}

func kinds(evts []event.Event) []event.Type {
	out := make([]event.Type, 0, len(evts))
	for _, e := range evts {
		out = append(out, e.Type)
	}
	return out
}

var _ provider.Kind = Kind
