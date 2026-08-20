package claude

import (
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// The wire shapes exercised in this file are NOT invented. Every one of them
// was read off the installed CLI's own emitters (2.1.234) rather than guessed
// from memory — the same discipline the package comment demands of
// testdata/*.ndjson:
//
//	strings "$(which claude)" | grep -oE 'type:"system",subtype:"[a-z_]+"'
//	strings "$(which claude)" | grep -oE 'subtype:"model_refusal_no_fallback".{400}'
//	strings "$(which claude)" | grep -oE 'subtype:"error_during_execution".{300}'
//
// Those greps are what established (a) that the stream-json transport spells
// these objects in snake_case even though the binary holds them in camelCase,
// (b) that the error result variants carry their message in `errors[]` and
// omit `result` entirely, and (c) that `api_refusal_category` really does
// carry a "cyber" value — the category an infrastructure question is most
// likely to trip, and the one that motivated this whole file.

func parseOne(t *testing.T, line string) []event.Event {
	t.Helper()
	st := newParseState("ssh:sc-abc::chat-7", "claude:default")
	return parseLine([]byte(line), st)
}

// findOne returns the single event of type typ, failing when there is not
// exactly one — "the reason appeared twice" is as much a bug as "it never
// appeared", since a doubled error reads as two separate failures.
func findOne(t *testing.T, evts []event.Event, typ event.Type) event.Event {
	t.Helper()
	var found []event.Event
	for _, e := range evts {
		if e.Type == typ {
			found = append(found, e)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 %s event, got %d (all: %v)", typ, len(found), typeNames(evts))
	}
	return found[0]
}

func typeNames(evts []event.Event) []string {
	out := make([]string, 0, len(evts))
	for _, e := range evts {
		out = append(out, string(e.Type))
	}
	return out
}

func errMessage(t *testing.T, e event.Event) string {
	t.Helper()
	p, ok := e.Payload.(*event.ErrorPayload)
	if !ok {
		t.Fatalf("payload is %T, want *event.ErrorPayload", e.Payload)
	}
	return p.Message
}

func warnMessage(t *testing.T, e event.Event) string {
	t.Helper()
	p, ok := e.Payload.(*event.WarningPayload)
	if !ok {
		t.Fatalf("payload is %T, want *event.WarningPayload", e.Payload)
	}
	return p.Message
}

// The regression this whole change exists for. A safeguard refusal with no
// fallback model ends the turn with ZERO output tokens: no assistant message,
// no tool call, nothing. The only copy of the reason is on this system line,
// and parseSystem used to drop every subtype except "init" — so the operator
// watched the turn go running -> idle with an empty transcript and no way to
// tell a refusal from a crash.
func TestModelRefusalNoFallbackBecomesAVisibleError(t *testing.T) {
	line := `{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-sonnet-5",` +
		`"request_id":"req_011","api_refusal_category":"cyber","api_refusal_explanation":null,` +
		`"refused_user_message_uuid":"u-1","content":"","session_id":"s-1","uuid":"e-1"}`

	e := findOne(t, parseOne(t, line), event.RuntimeError)
	msg := errMessage(t, e)
	if msg == "" {
		t.Fatal("refusal produced an empty message — a blank error row is still a silent turn")
	}
	// `content` is empty on this path (the binary emits `content:""`), so the
	// sentence has to be built from the category rather than copied.
	if !strings.Contains(msg, "cyber") {
		t.Errorf("message does not name the refusal category, so the operator cannot tell WHY: %q", msg)
	}
	if p := e.Payload.(*event.ErrorPayload); p.Code != "cyber" {
		t.Errorf("Code = %q, want the refusal category %q", p.Code, "cyber")
	}
}

// When the CLI does write an explanation, that sentence must win over the
// generic fallback — it is more specific than anything this parser can build.
func TestModelRefusalPrefersTheCLIsOwnSentence(t *testing.T) {
	line := `{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-sonnet-5",` +
		`"api_refusal_category":"cyber","api_refusal_explanation":null,` +
		`"content":"Claude declined this request.","session_id":"s-1","uuid":"e-1"}`

	if msg := errMessage(t, findOne(t, parseOne(t, line), event.RuntimeError)); msg != "Claude declined this request." {
		t.Errorf("message = %q, want the CLI's own content verbatim", msg)
	}
}

// A refusal that WAS retried against another model is a notice, not a failure:
// the turn is still alive. Getting this wrong in the other direction would put
// a red error row on a turn that then answers normally.
func TestModelRefusalFallbackIsANoticeNotAnError(t *testing.T) {
	line := `{"type":"system","subtype":"model_refusal_fallback","trigger":"refusal","direction":"retry",` +
		`"scope":"session","original_model":"claude-opus-5","fallback_model":"claude-sonnet-5",` +
		`"api_refusal_category":"cyber","content":"Switched models after a refusal","uuid":"e-2"}`

	evts := parseOne(t, line)
	for _, e := range evts {
		if e.Type == event.RuntimeError {
			t.Fatal("a retried refusal must not be reported as a turn failure")
		}
	}
	if msg := warnMessage(t, findOne(t, evts, event.RuntimeWarning)); !strings.Contains(msg, "claude-sonnet-5") {
		t.Errorf("notice does not name the model now running the turn: %q", msg)
	}
}

// The CLI's OWN permission layer denying a tool — distinct from
// parseControlRequest's auto-deny, which is DevDeck denying. An agent whose
// every tool call is denied by its settings otherwise produces a turn that
// does nothing and explains nothing.
func TestCLIPermissionDeniedReachesTheTranscript(t *testing.T) {
	line := `{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_9",` +
		`"agent_id":"a-1","decision_reason_type":"rule","decision_reason":"Bash(rm:*) is denied by settings",` +
		`"message":"Permission to use Bash has been denied.","uuid":"e-3","session_id":"s-1"}`

	e := findOne(t, parseOne(t, line), event.ToolDenied)
	p, ok := e.Payload.(*event.ToolDeniedPayload)
	if !ok {
		t.Fatalf("payload is %T, want *event.ToolDeniedPayload", e.Payload)
	}
	if p.ToolName != "Bash" {
		t.Errorf("ToolName = %q, want %q", p.ToolName, "Bash")
	}
	if p.Message == "" {
		t.Error("denial carries no reason")
	}
	if e.Refs == nil || e.Refs.CallID != "toolu_9" {
		t.Errorf("tool_use_id must ride in Refs.CallID, got %+v", e.Refs)
	}
}

// A stalled turn must read as "retrying", not as frozen.
func TestAPIRetryIsReportedWithItsReason(t *testing.T) {
	line := `{"type":"system","subtype":"api_retry","attempt":2,"max_retries":5,"retry_delay_ms":4000,` +
		`"error_status":529,"error":"overloaded","session_id":"s-1","uuid":"e-4"}`

	msg := warnMessage(t, findOne(t, parseOne(t, line), event.RuntimeWarning))
	for _, want := range []string{"overloaded", "529", "2", "5"} {
		if !strings.Contains(msg, want) {
			t.Errorf("retry notice is missing %q: %q", want, msg)
		}
	}
}

// Subtypes DevDeck deliberately does not surface stay silent. Without this the
// fix trades one bug for another: `status` and `informational` fire constantly,
// and a notice per line would bury the turn — the exact failure mode the
// tool_progress ignore-list already exists to prevent.
func TestUnsurfacedSystemSubtypesStaySilent(t *testing.T) {
	for _, subtype := range []string{"status", "informational", "compact_boundary", "thinking_tokens", "turn_starting"} {
		line := `{"type":"system","subtype":"` + subtype + `","session_id":"s-1","uuid":"e-5"}`
		if evts := parseOne(t, line); len(evts) != 0 {
			t.Errorf("subtype %q produced %v, want no events", subtype, typeNames(evts))
		}
	}
}

// The error result variants put their message in `errors[]` and omit `result`
// entirely. parseResult read neither, so the CLI's own explanation of the
// failure never left this package.
func TestErrorResultReportsItsErrorsArray(t *testing.T) {
	line := `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,` +
		`"stop_reason":null,"terminal_reason":"turn_setup_failed",` +
		`"errors":["queryParams builder failed: bad model"],"session_id":"s-1","uuid":"e-6",` +
		`"usage":{"input_tokens":10,"output_tokens":0}}`

	evts := parseOne(t, line)
	if msg := errMessage(t, findOne(t, evts, event.RuntimeError)); !strings.Contains(msg, "queryParams builder failed: bad model") {
		t.Errorf("the CLI's own error text did not reach the transcript: %q", msg)
	}
	// The turn must still settle. Reporting a reason and then leaving the
	// thread pinned on "running" would trade a silent turn for a stuck one.
	c := findOne(t, evts, event.TurnCompleted)
	if p := c.Payload.(*event.TurnCompletedPayload); p.Status != "failed" {
		t.Errorf("Status = %q, want %q", p.Status, "failed")
	}
	// Order is load-bearing: TurnCompleted settles the thread to idle, so a
	// reason emitted after it can land on a turn the client already closed.
	if evts[0].Type != event.RuntimeError {
		t.Errorf("event order is %v, want the error before the completion", typeNames(evts))
	}
}

// `subtype:"success"` does not mean the turn succeeded — the binary composes
// the common half (which carries is_error) separately from the variant half.
func TestSuccessSubtypeWithIsErrorStillReports(t *testing.T) {
	line := `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,` +
		`"stop_reason":null,"result":"Credit balance is too low","session_id":"s-1","uuid":"e-7"}`

	msg := errMessage(t, findOne(t, parseOne(t, line), event.RuntimeError))
	if !strings.Contains(msg, "Credit balance is too low") {
		t.Errorf("result text not reported: %q", msg)
	}
	if !strings.Contains(msg, "429") {
		t.Errorf("api_error_status not reported: %q", msg)
	}
}

// stop_reason "refusal" ends a turn with no output while leaving is_error
// false, so the one field parseResult used to read caught nothing.
func TestRefusalStopReasonReportsEvenWhenIsErrorIsFalse(t *testing.T) {
	line := `{"type":"result","subtype":"success","is_error":false,"stop_reason":"refusal",` +
		`"terminal_reason":"completed","result":"","session_id":"s-1","uuid":"e-8",` +
		`"usage":{"input_tokens":55965,"output_tokens":0}}`

	evts := parseOne(t, line)
	if msg := errMessage(t, findOne(t, evts, event.RuntimeError)); !strings.Contains(strings.ToLower(msg), "refus") {
		t.Errorf("a refusal stop_reason was not reported: %q", msg)
	}
}

// The happy path must stay untouched: no error row, and the assistant's final
// text (which `result` carries on success) must never be re-reported as an
// error underneath the reply the operator already read.
func TestSuccessfulResultReportsNothing(t *testing.T) {
	line := `{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn",` +
		`"terminal_reason":"completed","result":"pong","api_error_status":null,"session_id":"s-1",` +
		`"uuid":"e-9","usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":13797}}`

	evts := parseOne(t, line)
	for _, e := range evts {
		if e.Type == event.RuntimeError || e.Type == event.RuntimeWarning {
			t.Fatalf("a successful turn produced a %s", e.Type)
		}
	}
	c := findOne(t, evts, event.TurnCompleted)
	p := c.Payload.(*event.TurnCompletedPayload)
	if p.Status != "completed" {
		t.Errorf("Status = %q, want %q", p.Status, "completed")
	}
	if p.Usage == nil || p.Usage.OutputTokens != 4 || p.Usage.CacheReadTokens != 13797 {
		t.Errorf("usage lost while adding the failure path: %+v", p.Usage)
	}
}
