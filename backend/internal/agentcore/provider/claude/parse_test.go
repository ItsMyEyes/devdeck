package claude

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func parseFixture(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	st := newParseState("w-abc", "claude:default")
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		out = append(out, parseLine(append([]byte(nil), line...), st)...)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	return out
}

func TestFixtureProducesTextDeltas(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")
	if len(evts) == 0 {
		t.Fatal("fixture produced no events")
	}

	var text int
	for _, e := range evts {
		if e.Type != event.ContentDelta {
			continue
		}
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			t.Fatalf("ContentDelta payload is %T", e.Payload)
		}
		if p.Stream == event.StreamText {
			text++
		}
	}
	if text == 0 {
		t.Fatal("no text deltas parsed from a real turn")
	}
}

// Every event must carry the envelope identity the orchestration layer routes
// on. A missing InstanceID here is the bug that forced t3code's migration.
func TestEveryEventCarriesThreadAndInstance(t *testing.T) {
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.ThreadID != "w-abc" {
			t.Fatalf("event %s has ThreadID %q, want w-abc", e.Type, e.ThreadID)
		}
		if e.InstanceID != "claude:default" {
			t.Fatalf("event %s has InstanceID %q, want claude:default", e.Type, e.InstanceID)
		}
	}
}

// Sequence must be monotonic per (ItemID, Stream) — the client relies on it to
// detect dropped or reordered deltas.
func TestSequenceMonotonicPerItemAndStream(t *testing.T) {
	last := map[string]uint64{}
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			continue
		}
		key := e.ItemID + "|" + string(p.Stream)
		if prev, seen := last[key]; seen && p.Sequence <= prev {
			t.Fatalf("sequence went %d -> %d for %s", prev, p.Sequence, key)
		}
		last[key] = p.Sequence
	}
}

// The fixture's session/init message must produce a SessionStarted event
// carrying the native session id in Refs, never as orchestration identity.
func TestFixtureProducesSessionStarted(t *testing.T) {
	var found bool
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.Type != event.SessionStarted {
			continue
		}
		found = true
		if e.Refs == nil || e.Refs.SessionID == "" {
			t.Fatalf("session started event missing native session id in Refs: %+v", e.Refs)
		}
	}
	if !found {
		t.Fatal("fixture's system/init message did not produce a SessionStarted event")
	}
}

// The fixture's result message must produce a TurnCompleted event with usage
// filled from the token counts.
func TestFixtureProducesTurnCompletedWithUsage(t *testing.T) {
	var found bool
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.Type != event.TurnCompleted {
			continue
		}
		found = true
		p, ok := e.Payload.(*event.TurnCompletedPayload)
		if !ok {
			t.Fatalf("TurnCompleted payload is %T", e.Payload)
		}
		if p.Status != "completed" {
			t.Fatalf("status = %q, want completed", p.Status)
		}
		if p.Usage == nil || p.Usage.OutputTokens == 0 {
			t.Fatalf("usage not filled: %+v", p.Usage)
		}
	}
	if !found {
		t.Fatal("fixture's result message did not produce a TurnCompleted event")
	}
}

// A message shape the parser does not understand must degrade to a warning
// that carries the raw payload, never a crash and never a silent drop. This
// WILL happen the next time the CLI ships a new event type.
func TestUnknownMessageBecomesWarningWithRaw(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{"type":"totally_new_thing","whatever":1}`), st)

	if len(evts) != 1 {
		t.Fatalf("got %d events, want 1 warning", len(evts))
	}
	if evts[0].Type != event.RuntimeWarning {
		t.Fatalf("type = %s, want runtime.warning", evts[0].Type)
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("warning must carry the raw payload for debugging")
	}
}

func TestMalformedJSONBecomesWarning(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{not json at all`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("got %+v, want a single runtime.warning", evts)
	}
}

// Reasoning must land on its own stream so the UI can collapse it separately.
// Merging it into text now would mean a data migration later.
func TestReasoningUsesItsOwnStream(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	raw := `{"type":"stream_event","event":{"type":"content_block_delta",` +
		`"index":0,"delta":{"type":"thinking_delta","thinking":"considering..."}}}`

	var found bool
	for _, e := range parseLine([]byte(raw), st) {
		if p, ok := e.Payload.(*event.ContentDeltaPayload); ok && p.Stream == event.StreamReasoning {
			found = true
		}
	}
	if !found {
		t.Fatal("thinking_delta must map to StreamReasoning")
	}
}

func TestControlRequestAskUserQuestionProducesUserInputRequested(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_askuser.ndjson")
	if len(evts) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(evts), evts)
	}
	e := evts[0]
	if e.Type != event.UserInputRequested {
		t.Fatalf("type = %s, want user-input.requested", e.Type)
	}
	// A test that fails if someone reads request.request_id instead of the
	// top-level one — the two differ in the fixture on purpose only in that
	// the fixture has no nested request_id at all, so a bug reading the wrong
	// field would leave RequestID empty.
	if e.RequestID != "f327a720-0000-0000-0000-000000000001" {
		t.Fatalf("RequestID = %q, want the TOP-LEVEL request_id", e.RequestID)
	}
	if e.Refs == nil || e.Refs.CallID != "toolu_01HMT3example" {
		t.Fatalf("Refs.CallID = %+v, want tool_use_id", e.Refs)
	}
	p, ok := e.Payload.(*event.UserInputRequestedPayload)
	if !ok {
		t.Fatalf("payload = %T", e.Payload)
	}
	var qs []map[string]any
	if err := json.Unmarshal(p.Questions, &qs); err != nil {
		t.Fatalf("questions: %v", err)
	}
	if qs[0]["id"] != "Do you prefer tabs or spaces for indentation?" {
		t.Fatalf("id = %v, want the full question text", qs[0]["id"])
	}
}

func TestControlRequestQuestionFallsBackToIndexedID(t *testing.T) {
	// A question with no `question` string must still get a stable id.
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"header":"H","options":[]}]},"tool_use_id":"t1","requires_user_interaction":true}}`)
	evts := parseLine(line, st)
	p := evts[0].Payload.(*event.UserInputRequestedPayload)
	var qs []map[string]any
	_ = json.Unmarshal(p.Questions, &qs)
	if qs[0]["id"] != "q-0" {
		t.Fatalf("id = %v, want q-0", qs[0]["id"])
	}
}

func TestControlRequestExitPlanModeIsNotUserInput(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_exitplanmode.ndjson")
	for _, e := range evts {
		if e.Type == event.UserInputRequested {
			t.Fatalf("ExitPlanMode must not be classified as user input: %+v", e)
		}
	}
	// A1 auto-denies it and reports the denial in the transcript.
	if len(evts) != 1 || evts[0].Type != event.ToolDenied {
		t.Fatalf("events = %+v, want exactly one tool.denied", evts)
	}
}

func TestControlRequestUnknownSubtypeIsOneWarning(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_unknown_subtype.ndjson")
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want exactly one runtime.warning", evts)
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("warning must carry Raw for debugging")
	}
}

// Every control_request carries a top-level request_id, which means the CLI is
// blocked waiting for a control_response echoing it — and the capture measured
// NO CLI-side timeout (57s, unanswered). Understanding a request only well
// enough to warn about it therefore still hangs the session forever.
//
// The unknown-TOOL branch already auto-denies for exactly this reason. These
// two branches did not, which made the invariant true only for the shapes that
// happened to be observed.
func TestUnansweredControlRequestClassesAreStillAnswered(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{
			"unknown subtype",
			`{"type":"control_request","request_id":"r-sub","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}`,
		},
		{
			"malformed request body",
			`{"type":"control_request","request_id":"r-bad","request":"not-an-object"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newParseState("w-abc", "claude:default")
			evts := parseLine([]byte(tc.line), st)

			// Still visible: an unfamiliar shape must reach the transcript.
			if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
				t.Fatalf("events = %+v, want exactly one runtime.warning", evts)
			}

			denies := st.takeAutoDenies()
			if len(denies) != 1 {
				t.Fatalf("autoDenies = %+v, want exactly one — an unanswered request hangs the CLI", denies)
			}
			if denies[0].requestID == "" {
				t.Fatal("the deny must echo the request id, or the CLI cannot match it")
			}
		})
	}
}

// The one shape that genuinely cannot be answered: no id to echo. It must warn
// and must NOT queue a reply keyed by the empty string.
func TestControlRequestWithNoRequestIDIsWarnedNotAnswered(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Write"}}`), st)

	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want exactly one runtime.warning", evts)
	}
	if denies := st.takeAutoDenies(); len(denies) != 0 {
		t.Fatalf("autoDenies = %+v, want none — there is no id to answer", denies)
	}
}

func TestControlCancelRequestRetiresAPendingQuestion(t *testing.T) {
	evts := parseFixture(t, "testdata/control_cancel_userinput.ndjson")
	if len(evts) != 2 {
		t.Fatalf("got %d events, want 2 (requested + resolved): %+v", len(evts), evts)
	}
	if evts[1].Type != event.UserInputResolved {
		t.Fatalf("second event type = %s, want user-input.resolved", evts[1].Type)
	}
	if evts[1].RequestID != "c33ce000-0000-0000-0000-000000000004" {
		t.Fatalf("resolved RequestID = %q", evts[1].RequestID)
	}
}

func TestControlResponseWithNoRequestIDIsIgnoredNotWarned(t *testing.T) {
	evts := parseFixture(t, "testdata/control_response_no_id.ndjson")
	if len(evts) != 0 {
		t.Fatalf("events = %+v, want none — control_response is recognized noise", evts)
	}
}

func TestControlRequestBashProducesRequestOpenedWithClassification(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_bash_blocked.ndjson")
	if len(evts) != 1 || evts[0].Type != event.RequestOpened {
		t.Fatalf("events = %+v, want exactly one request.opened", evts)
	}
	e := evts[0]
	if e.RequestID != "d44ce000-0000-0000-0000-000000000005" {
		t.Fatalf("RequestID = %q", e.RequestID)
	}
	p, ok := e.Payload.(*event.RequestOpenedPayload)
	if !ok {
		t.Fatalf("payload = %T", e.Payload)
	}
	if p.RequestType != event.ReqCommandExecApproval {
		t.Fatalf("requestType = %s, want command_execution_approval", p.RequestType)
	}
	// blocked_path is the most specific thing the CLI says about WHY it
	// asked — it must be folded into Detail.
	if !strings.Contains(p.Detail, "/tmp/scratch") {
		t.Fatalf("Detail = %q, want it to mention the blocked path", p.Detail)
	}
	wantOptions := map[event.Decision]bool{
		event.DecisionAccept: true, event.DecisionAcceptForSession: true,
		event.DecisionDecline: true, event.DecisionCancel: true,
	}
	for _, opt := range p.Options {
		delete(wantOptions, opt)
	}
	if len(wantOptions) != 0 {
		t.Fatalf("Options = %v, missing %v", p.Options, wantOptions)
	}
}

// The worst kind of permission bug: "Always allow this session" silently
// degrading to "allow once" because the CLI sent no suggestions to echo.
func TestControlRequestWithNoSuggestionsExcludesAcceptForSession(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_webfetch_accept.ndjson")
	p := evts[0].Payload.(*event.RequestOpenedPayload)
	for _, opt := range p.Options {
		if opt == event.DecisionAcceptForSession {
			t.Fatal("acceptForSession must be withheld when permission_suggestions is empty")
		}
	}
}

func TestControlCancelRequestRetiresAPendingApproval(t *testing.T) {
	evts := parseFixture(t, "testdata/control_cancel_approval.ndjson")
	if len(evts) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(evts), evts)
	}
	resolved, ok := evts[1].Payload.(*event.RequestResolvedPayload)
	if !ok {
		t.Fatalf("second payload = %T, want *RequestResolvedPayload", evts[1].Payload)
	}
	if resolved.Decision != event.DecisionCancel {
		t.Fatalf("decision = %s, want cancel", resolved.Decision)
	}
	if resolved.RequestType != event.ReqFileChangeApproval {
		t.Fatalf("requestType = %s, want file_change_approval", resolved.RequestType)
	}
}

func TestControlRequestExitPlanModeStillAutoDeniesInA2(t *testing.T) {
	// A2 must not regress A1's plan-mode safety net — re-run T1's fixture.
	evts := parseFixture(t, "testdata/control_request_exitplanmode.ndjson")
	if len(evts) != 1 || evts[0].Type != event.ToolDenied {
		t.Fatalf("events = %+v, want exactly one tool.denied — A2 must not turn ExitPlanMode into an approval", evts)
	}
}

// --- T4: plan capture ------------------------------------------------------

// extractExitPlanModePlan mirrors t3code's extractExitPlanModePlan
// (ClaudeAdapter.ts:1379-1389): trim-then-check, not just non-empty-check.
func TestExtractExitPlanModePlan(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{"present non-empty", `{"plan":"# Plan\n1. Do a thing"}`, "# Plan\n1. Do a thing", true},
		{"present but blank", `{"plan":"   \n\t "}`, "", false},
		{"key absent", `{"planFilePath":"/x.md"}`, "", false},
		{"wrong json type", `{"plan":42}`, "", false},
		{"trims surrounding whitespace", `{"plan":"  hello  "}`, "hello", true},
		{"malformed input object", `not-json`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := extractExitPlanModePlan(json.RawMessage(tc.input))
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if got != tc.want {
				t.Fatalf("plan = %q, want %q", got, tc.want)
			}
		})
	}
}

// The "assistant" line is the primary path (design.md §1.1) — the block's
// own input_json_delta stream carries zero bytes for ExitPlanMode.
func TestAssistantExitPlanModeProducesTurnProposedCompleted(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"ExitPlanMode","input":{"plan":"# Plan\nDo X","planFilePath":"/home/user/.claude/plans/x.md"}}]}}`)
	evts := parseLine(line, st)
	if len(evts) != 1 || evts[0].Type != event.TurnProposedCompleted {
		t.Fatalf("events = %+v, want exactly one turn.proposed.completed", evts)
	}
	p, ok := evts[0].Payload.(*event.ProposedPlanPayload)
	if !ok {
		t.Fatalf("payload = %T, want *ProposedPlanPayload", evts[0].Payload)
	}
	if p.PlanMarkdown != "# Plan\nDo X" {
		t.Fatalf("PlanMarkdown = %q", p.PlanMarkdown)
	}
	if p.PlanFilePath != "/home/user/.claude/plans/x.md" {
		t.Fatalf("PlanFilePath = %q", p.PlanFilePath)
	}
	if p.ToolUseID != "toolu_1" {
		t.Fatalf("ToolUseID = %q", p.ToolUseID)
	}
	if evts[0].Refs == nil || evts[0].Refs.CallID != "toolu_1" {
		t.Fatalf("Refs.CallID = %+v, want toolu_1", evts[0].Refs)
	}
}

func TestAssistantExitPlanModeBlankPlanProducesNoEvent(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"ExitPlanMode","input":{"plan":"   "}}]}}`)
	evts := parseLine(line, st)
	if len(evts) != 0 {
		t.Fatalf("events = %+v, want none for a blank plan", evts)
	}
}

// The "deliberately not mapped" contract for ordinary assistant lines must
// survive splitting "assistant" out of the shared no-op case.
func TestAssistantWithoutExitPlanModeProducesNoEvent(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`)
	evts := parseLine(line, st)
	if len(evts) != 0 {
		t.Fatalf("events = %+v, want none", evts)
	}
}

func TestAssistantExitPlanModeDedupesByToolUseID(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_dup","name":"ExitPlanMode","input":{"plan":"# Plan\nDo X"}}]}}`)
	first := parseLine(line, st)
	second := parseLine(line, st)
	if len(first) != 1 {
		t.Fatalf("first call events = %+v, want exactly one", first)
	}
	if len(second) != 0 {
		t.Fatalf("second call (same tool_use_id) events = %+v, want none — dedupe must suppress the repeat", second)
	}
}

// §1.2: the control_request path is redundancy inside A's own classifier —
// it must still capture a plan the assistant line has not already claimed.
func TestControlRequestExitPlanModeAlsoCapturesPlanWhenNew(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"control_request","request_id":"r-plan-1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"# Plan\nDo Y","planFilePath":"/x.md"},"tool_use_id":"toolu_cr1","requires_user_interaction":true}}`)
	evts := parseLine(line, st)
	if len(evts) != 2 {
		t.Fatalf("events = %+v, want tool.denied + turn.proposed.completed", evts)
	}
	if evts[0].Type != event.ToolDenied {
		t.Fatalf("first event = %s, want tool.denied — the deny reply is not optional", evts[0].Type)
	}
	if evts[1].Type != event.TurnProposedCompleted {
		t.Fatalf("second event = %s, want turn.proposed.completed", evts[1].Type)
	}
	p, ok := evts[1].Payload.(*event.ProposedPlanPayload)
	if !ok {
		t.Fatalf("payload = %T, want *ProposedPlanPayload", evts[1].Payload)
	}
	if p.PlanMarkdown != "# Plan\nDo Y" || p.ToolUseID != "toolu_cr1" || p.PlanFilePath != "/x.md" {
		t.Fatalf("payload = %+v", p)
	}
}

// The capture shows the assistant line arriving first for a shared
// tool_use_id — this is the case that makes §1.2 "in practice a no-op".
func TestControlRequestExitPlanModeSuppressedWhenAlreadyCapturedByAssistantLine(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	assistantLine := []byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_shared","name":"ExitPlanMode","input":{"plan":"# Plan\nShared"}}]}}`)
	if evts := parseLine(assistantLine, st); len(evts) != 1 {
		t.Fatalf("assistant line events = %+v, want exactly one", evts)
	}

	crLine := []byte(`{"type":"control_request","request_id":"r-plan-2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"# Plan\nShared"},"tool_use_id":"toolu_shared","requires_user_interaction":true}}`)
	evts := parseLine(crLine, st)
	if len(evts) != 1 || evts[0].Type != event.ToolDenied {
		t.Fatalf("events = %+v, want exactly one tool.denied — the plan was already captured on the assistant line", evts)
	}
}

// Guards the fixture itself: the assistant line's ExitPlanMode block must
// keep carrying a non-empty input.plan, or a future CLI recapture has
// silently dropped the plan text and this must fail loudly, not degrade.
func TestFixtureAssistantLineStillCarriesPlanText(t *testing.T) {
	f, err := os.Open("testdata/plan.ndjson")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	var found bool
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var w struct {
			Type    string `json:"type"`
			Message struct {
				Content []struct {
					Type  string          `json:"type"`
					Name  string          `json:"name"`
					Input json.RawMessage `json:"input"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(line, &w); err != nil || w.Type != "assistant" {
			continue
		}
		for _, block := range w.Message.Content {
			if block.Type != "tool_use" || block.Name != "ExitPlanMode" {
				continue
			}
			found = true
			if plan, ok := extractExitPlanModePlan(block.Input); !ok || plan == "" {
				t.Fatalf("fixture's assistant-line ExitPlanMode block lost input.plan — recapture testdata/plan.ndjson: %s", block.Input)
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !found {
		t.Fatal("fixture no longer has an assistant-line ExitPlanMode tool_use block — recapture testdata/plan.ndjson")
	}
}

// The dedupe guard, exercised over the real fixture: the plan appears on
// both the assistant line (141) and the control_request line (142) sharing
// one tool_use_id, so exactly one turn.proposed.completed must come out —
// not two, and not zero.
func TestFixtureProducesExactlyOneProposedPlan(t *testing.T) {
	evts := parseFixture(t, "testdata/plan.ndjson")
	var proposed []event.Event
	for _, e := range evts {
		if e.Type == event.TurnProposedCompleted {
			proposed = append(proposed, e)
		}
	}
	if len(proposed) != 1 {
		t.Fatalf("got %d turn.proposed.completed events, want exactly 1 (dedupe across assistant + control_request lines): %+v", len(proposed), proposed)
	}
	p, ok := proposed[0].Payload.(*event.ProposedPlanPayload)
	if !ok {
		t.Fatalf("payload = %T, want *ProposedPlanPayload", proposed[0].Payload)
	}
	if !strings.Contains(p.PlanMarkdown, "Run shell command") {
		t.Fatalf("PlanMarkdown = %q, missing expected plan content", p.PlanMarkdown)
	}
	if p.ToolUseID == "" {
		t.Fatal("ToolUseID must be set from the captured tool_use_id")
	}
	if p.PlanFilePath == "" {
		t.Fatal("PlanFilePath must be set from the captured planFilePath")
	}
}

// §1.4: the dead disabled-tool-row bug. ExitPlanMode's content block must
// produce neither an ItemStarted nor an ItemCompleted — ItemType ToolCall
// events over this fixture must come exactly from the OTHER four tool_use
// blocks (ToolSearch, Bash, Write x2), not five.
func TestFixtureExitPlanModeBlockProducesNoItemEvents(t *testing.T) {
	evts := parseFixture(t, "testdata/plan.ndjson")

	var started, completed int
	for _, e := range evts {
		switch p := e.Payload.(type) {
		case *event.ItemStartedPayload:
			if p.ItemType != event.ItemToolCall {
				continue
			}
			started++
			if p.Title == "ExitPlanMode" {
				t.Fatalf("got ItemStarted for the ExitPlanMode block, want none (§1.4 dead row): %+v", e)
			}
		case *event.ItemCompletedPayload:
			if p.ItemType != event.ItemToolCall {
				continue
			}
			completed++
		}
	}
	if started != 4 {
		t.Fatalf("ItemStarted(tool_call) count = %d, want 4 (5 tool_use blocks minus ExitPlanMode)", started)
	}
	if completed != 4 {
		t.Fatalf("ItemCompleted(tool_call) count = %d, want 4 (5 tool_use blocks minus ExitPlanMode)", completed)
	}
}

// The pre-existing 2.1.224 fixture must still parse unchanged — recapturing
// the plan fixture must not perturb the turn fixture's behavior.
func TestTurnFixtureStillParsesUnchangedAlongsidePlanCapture(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")
	for _, e := range evts {
		if e.Type == event.TurnProposedCompleted {
			t.Fatalf("turn.ndjson unexpectedly produced turn.proposed.completed: %+v", e)
		}
	}
}

var _ = json.Marshal

// Progress and telemetry frames the CLI emits during any long tool call. The
// source for treating them as recognized-but-ignored is the CLI's own
// reference consumer: `strings` on the 2.1.234 binary shows its
// `sdkMessageAdapter` carrying "Ignoring heartbeat/subagent-retry
// tool_progress frame", "Ignoring tool_use_summary message" and "Ignoring
// auth_status message" beside the same unknown-type fallback this parser has.
//
// This matters more than it looks: a warning is no longer invisible. The
// client used to drop `runtime.warning` on the floor; now it renders one
// notice row per warning, so a single `for i in 1..10; sleep` command would
// bury its own turn under identical "unrecognized message type" rows.
func TestProgressAndTelemetryFramesAreIgnoredNotWarned(t *testing.T) {
	for _, msgType := range []string{"tool_progress", "tool_use_summary", "auth_status", "autocompact_state"} {
		t.Run(msgType, func(t *testing.T) {
			st := newParseState("w-abc", "claude:default")
			line := []byte(`{"type":"` + msgType + `","toolUseID":"toolu_1","subtype":"heartbeat"}`)
			if evts := parseLine(line, st); len(evts) != 0 {
				t.Fatalf("%s produced %d event(s), want none: %+v", msgType, len(evts), evts)
			}
		})
	}
}

// The fallback must still fire for a shape this parser has genuinely never
// seen — the ignore list above is an allowlist, not a reason to go quiet in
// general.
func TestAGenuinelyUnknownMessageTypeStillWarns(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{"type":"some_future_frame"}`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("want one RuntimeWarning, got %+v", evts)
	}
}

// A control_response the CLI answers with subtype "error" is a REFUSAL of
// something DevDeck asked for, and it used to be dropped whole along with the
// successful acks. That is how the Permission pill and the live process came
// to disagree in silence: switching a thread to full access on a session that
// was not launched with the unlock flag is refused right here, and the only
// evidence anyone ever saw was that the approval cards never stopped.
func TestControlResponseErrorIsSurfacedAsAWarning(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	const refusal = "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"
	evts := parseLine([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"setmode-1","error":`+
		strconv.Quote(refusal)+`}}`), st)

	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want exactly one runtime.warning", evts)
	}
	p, ok := evts[0].Payload.(*event.WarningPayload)
	if !ok {
		t.Fatalf("payload = %T, want *event.WarningPayload", evts[0].Payload)
	}
	if !strings.Contains(p.Message, refusal) {
		t.Fatalf("warning = %q, must carry the CLI's own reason", p.Message)
	}
}

// The successful ack is the common case (every set_model, set_permission_mode
// and interrupt receipt answers one) and must stay silent — a notice on each
// would bury the turn, which is exactly why the whole shape was ignored before.
func TestControlResponseSuccessStaysSilent(t *testing.T) {
	for _, line := range []string{
		`{"type":"control_response","response":{"subtype":"success","request_id":"setmode-1","response":{"mode":"bypassPermissions"}}}`,
		`{"type":"control_response","response":{"subtype":"success"}}`,
		`{"type":"control_response"}`,
	} {
		st := newParseState("w-abc", "claude:default")
		if evts := parseLine([]byte(line), st); len(evts) != 0 {
			t.Fatalf("line %s produced %+v, want no events", line, evts)
		}
	}
}
