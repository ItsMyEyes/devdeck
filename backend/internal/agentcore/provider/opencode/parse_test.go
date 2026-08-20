package opencode

import (
	"bufio"
	"bytes"
	"os"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// The fixture is REAL traffic: captured from `GET /api/session/{id}/event` on
// opencode 1.18.18 while a live prompt ran. That matters more than usual here
// — t3code's adapter listens for `message.part.delta`/`message.part.updated`,
// and against this binary NONE of those fire. A fixture written from t3code's
// names would have "proved" a parser that recognises nothing in practice.
func parseFixture(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	st := newParseState("w-abc", "ses_ff1eb8e4effeYV8sjasAwvca4o", "opencode:default")
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		out = append(out, parseEvent(append([]byte(nil), line...), st)...)
	}
	return out
}

func kinds(evts []event.Event) []event.Type {
	out := make([]event.Type, 0, len(evts))
	for _, e := range evts {
		out = append(out, e.Type)
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
	if !started || !completed {
		t.Fatalf("turn lifecycle incomplete; got %+v", kinds(evts))
	}
}

// Every event in the captured stream must be understood. An unrecognised one
// becomes a RuntimeWarning, so a warning here means this parser is out of date
// with the binary it was built against — which is the whole point of keeping a
// captured fixture rather than a synthetic one.
func TestNothingInTheCaptureIsUnrecognised(t *testing.T) {
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.Type == event.RuntimeWarning {
			p := e.Payload.(*event.WarningPayload)
			t.Fatalf("captured event not understood: %s", p.Message)
		}
	}
}

func TestAssistantTextReachesTheTranscript(t *testing.T) {
	var text string
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if p, ok := e.Payload.(*event.ContentDeltaPayload); ok && p.Stream == event.StreamText {
			text += p.Text
		}
	}
	if text == "" {
		t.Fatal("no assistant text was produced from a turn that visibly replied")
	}
}

// The user's own prompt comes back on the stream. It is already in the
// transcript, so echoing it would duplicate every message typed.
func TestTheUsersOwnPromptIsNotEchoed(t *testing.T) {
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if p, ok := e.Payload.(*event.ContentDeltaPayload); ok && p.Text == "say hi" {
			t.Fatal("the user's own prompt was echoed back into the transcript")
		}
	}
}

// Reasoning tokens are generated output — folding them into OutputTokens is
// what keeps the transcript's tokens-per-second honest, since the rate may
// only ever be computed from generated tokens.
func TestStepEndCarriesUsageIncludingReasoning(t *testing.T) {
	var usage *event.Usage
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if p, ok := e.Payload.(*event.TurnCompletedPayload); ok {
			usage = p.Usage
		}
	}
	if usage == nil {
		t.Fatal("the captured step end reported tokens; usage must survive")
	}
	if usage.InputTokens != 3583 {
		t.Fatalf("inputTokens = %d, want 3583", usage.InputTokens)
	}
	// 11 output + 46 reasoning, both generated.
	if usage.OutputTokens != 57 {
		t.Fatalf("outputTokens = %d, want 57 (output plus reasoning)", usage.OutputTokens)
	}
}

func TestUnknownEventWarnsWithRaw(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	evts := parseEvent([]byte(`{"type":"session.next.somethingNew","data":{}}`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want one warning", kinds(evts))
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("a warning must carry Raw for debugging")
	}
}

// Before this, a `session.error` produced only a warning: if the session
// never went on to send `session.next.step.ended` for the turn already in
// flight, nothing else in this file ever closed it out and the thread sat on
// "running" forever. A fatal error must settle the turn the same way a
// completed or interrupted one does.
// The verified turn-failure signal (live capture against a real
// `opencode serve` 1.18.18, bash permission set to "ask", a prompt that
// asked for a nonexistent tool result): session.next.step.failed, not
// session.error, is what an errored step actually sends on the per-session
// stream this file reads.
func TestStepFailedSettlesTheTurnAsFailed(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	line := []byte(`{"type":"session.next.step.failed","data":{"timestamp":1,"sessionID":"ses_1",` +
		`"assistantMessageID":"msg_1","error":{"type":"unknown","message":"upstream 500"}}}`)
	evts := parseEvent(line, st)

	var warned, completed bool
	for _, e := range evts {
		switch e.Type {
		case event.RuntimeWarning:
			warned = true
			p := e.Payload.(*event.WarningPayload)
			if p.Message != "upstream 500" {
				t.Fatalf("warning message = %q, want the error's own message", p.Message)
			}
		case event.TurnCompleted:
			completed = true
			p := e.Payload.(*event.TurnCompletedPayload)
			if p.Status != "failed" {
				t.Fatalf("status = %q, want failed", p.Status)
			}
		}
	}
	if !warned {
		t.Fatalf("the error must stay visible in the transcript; got %+v", kinds(evts))
	}
	if !completed {
		t.Fatalf("the turn must be explicitly settled, not left running; got %+v", kinds(evts))
	}
}

// session.error was never observed on the per-session stream in the live
// capture (see the package comment) and is likely unreachable through
// parseEvent today — but the case is kept as a defensive no-cost fallback,
// so it must still behave correctly if it's ever wrong about that.
func TestSessionErrorBeltAndBracesStillSettlesTheTurn(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	evts := parseEvent([]byte(`{"type":"session.error","data":{"message":"upstream 500"}}`), st)

	var completed bool
	for _, e := range evts {
		if e.Type == event.TurnCompleted {
			completed = true
		}
	}
	if !completed {
		t.Fatalf("the turn must be explicitly settled, not left running; got %+v", kinds(evts))
	}
}

// permission.v2.asked's shape below is lifted verbatim from a live capture
// (2026-08-18): a real pending bash approval on a running `opencode serve`
// 1.18.18 had exactly this `data` shape, and replying {"reply":"once"} to it
// actually unblocked the tool call.
func TestPermissionAskedOpensARequestOnTheGlobalBus(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	line := []byte(`{"id":"evt_1","type":"permission.v2.asked","data":{"id":"per_1","sessionID":"ses_1",` +
		`"action":"bash","resources":["echo hello"],"save":["echo hello"],` +
		`"source":{"type":"tool","messageID":"msg_1","callID":"call_1"}}}`)

	evts := parseGlobalEvent(line, st)
	if len(evts) != 1 || evts[0].Type != event.RequestOpened {
		t.Fatalf("events = %+v, want one request.opened", kinds(evts))
	}
	if evts[0].RequestID != "per_1" {
		t.Fatalf("RequestID = %q, want the permission's own id", evts[0].RequestID)
	}
	p := evts[0].Payload.(*event.RequestOpenedPayload)
	if p.RequestType != event.ReqCommandExecApproval {
		t.Fatalf("requestType = %q, want command exec approval for action=bash", p.RequestType)
	}
	if p.Detail != "echo hello" {
		t.Fatalf("detail = %q, want the actual command from resources[0]", p.Detail)
	}
	for _, want := range []event.Decision{event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline} {
		found := false
		for _, got := range p.Options {
			if got == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("options = %+v, missing %q", p.Options, want)
		}
	}
	for _, got := range p.Options {
		if got == event.DecisionCancel {
			t.Fatal("options must not offer cancel — OpenCode's reply vocabulary has no distinct cancel-and-abort")
		}
	}
}

// permission.v2.replied is our own reply's echo; there is nothing for the
// caller to do with it (no local pending state to retire, unlike codex).
func TestPermissionRepliedProducesNoEvents(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	line := []byte(`{"id":"evt_2","type":"permission.v2.replied","data":{"sessionID":"ses_1","requestID":"per_1","reply":"once"}}`)
	if evts := parseGlobalEvent(line, st); len(evts) != 0 {
		t.Fatalf("events = %+v, want none", kinds(evts))
	}
}

// server.connected/server.heartbeat are normal, constant global-bus chatter
// (observed on every live capture) — they must stay silent, not warn.
func TestGlobalBusHeartbeatsAreSilent(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	for _, typ := range []string{"server.connected", "server.heartbeat"} {
		if evts := parseGlobalEvent([]byte(`{"type":"`+typ+`","data":{}}`), st); len(evts) != 0 {
			t.Fatalf("%s: events = %+v, want none", typ, kinds(evts))
		}
	}
}

func TestUnknownGlobalEventWarns(t *testing.T) {
	st := newParseState("w-abc", "ses_1", "opencode:default")
	evts := parseGlobalEvent([]byte(`{"type":"something.brand.new","data":{}}`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want one warning", kinds(evts))
	}
}

// Two assistant messages each number their text blocks from "text-0"; keying
// on textID alone would collapse them onto one transcript item.
func TestTextItemsAreKeyedPerMessage(t *testing.T) {
	if a, b := itemID("msg_1", "text-0"), itemID("msg_2", "text-0"); a == b {
		t.Fatalf("item ids collide across messages: %q", a)
	}
}
