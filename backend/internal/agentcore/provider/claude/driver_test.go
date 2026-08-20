package claude

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

func TestDriverKindAndDefaults(t *testing.T) {
	d := NewDriver()
	if d.Kind() != "claude" {
		t.Fatalf("kind = %s, want claude", d.Kind())
	}
	cfg, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil {
		t.Fatalf("default config must decode: %v", err)
	}
	if cfg.ProviderKind() != "claude" {
		t.Fatalf("config kind = %s", cfg.ProviderKind())
	}
}

// A missing binary is a STATUS, not an error. Probe must report it so the UI
// can show "not installed" instead of swallowing an error, and the settings
// screen must never need to spawn an agent to find out.
func TestProbeReportsMissingBinaryAsStatus(t *testing.T) {
	d := NewDriver()
	cfg, err := d.DecodeConfig(json.RawMessage(`{"binaryName":"definitely-not-a-real-binary-xyz"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	snap, err := d.Probe(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Probe must not error for a missing binary, got: %v", err)
	}
	if snap.Available {
		t.Fatal("snapshot should report Available=false")
	}
	if snap.Detail == "" {
		t.Fatal("snapshot must explain why it is unavailable")
	}
}

func TestDecodeConfigRejectsGarbage(t *testing.T) {
	d := NewDriver()
	if _, err := d.DecodeConfig(json.RawMessage(`{"homeDir":123}`)); err == nil {
		t.Fatal("type-mismatched config should error — this message reaches the settings UI")
	}
}

var _ provider.Driver = NewDriver()

// Regression: buildArgs omitted --verbose, and the CLI refuses to start
// without it ("When using --print, --output-format=stream-json requires
// --verbose"). Every session died the instant it spawned; the only symptom
// the user ever saw was a later "thread has no active session" from SendTurn,
// because stderr was going nowhere. Six sent messages produced silence.
func TestBuildArgsCarriesTheFlagsTheCLIDemands(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{})

	joined := strings.Join(args, " ")
	for _, required := range []string{
		"--print",
		"--output-format stream-json",
		"--input-format stream-json",
		"--verbose",
	} {
		if !strings.Contains(joined, required) {
			t.Errorf("buildArgs missing %q; got: %s", required, joined)
		}
	}
}

func TestBuildArgsMapsModesToASinglePermissionFlag(t *testing.T) {
	// Plan mode is itself a --permission-mode value, so it must not stack a
	// second flag on top of the RuntimeMode mapping.
	args := buildArgs(Config{}, provider.SessionStartInput{
		Interact: provider.InteractionPlan,
		Mode:     provider.ModeFullAccess,
	})
	count := 0
	for _, a := range args {
		if a == "--permission-mode" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("--permission-mode appeared %d times, want exactly 1: %v", count, args)
	}
	if !strings.Contains(strings.Join(args, " "), "--permission-mode plan") {
		t.Fatalf("plan mode should win over runtime mode; got: %v", args)
	}
}

// The composer's Reasoning/Context Window picker rides ModelSelection.Options
// — confirmed real CLI flags (`claude --help`), not guessed. --effort and
// --autocompact both must translate exactly, and neither should appear at all
// when the composer sent nothing.
func TestBuildArgsTranslatesEffortAndContextWindowOptions(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		Model: provider.ModelSelection{
			Options: map[string]any{"effort": "xhigh", "contextWindow": "500k"},
		},
	})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--effort xhigh") {
		t.Errorf("missing --effort xhigh; got: %s", joined)
	}
	if !strings.Contains(joined, "--autocompact 500k") {
		t.Errorf("missing --autocompact 500k; got: %s", joined)
	}
}

func TestBuildArgsOmitsEffortAndContextWindowFlagsWhenUnset(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{})
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--effort") || strings.Contains(joined, "--autocompact") {
		t.Fatalf("buildArgs must not invent a value the composer never sent; got: %s", joined)
	}
}

// Options is a loosely-typed map[string]any straight off the wire — a
// non-string value (or a key from an unrelated feature) must be ignored, not
// panic or get stringified into a bogus flag.
func TestBuildArgsIgnoresNonStringOptionValues(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		Model: provider.ModelSelection{
			Options: map[string]any{"effort": 3, "contextWindow": true, "fastMode": "on"},
		},
	})
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--effort") || strings.Contains(joined, "--autocompact") {
		t.Fatalf("non-string option values must be ignored, not forwarded; got: %s", joined)
	}
}

// Correction 1 (spec §0): today's approval-required mode is silent-denial,
// not "asks but can't answer" — the flag is what turns it into a real ask,
// and AskUserQuestion is not even offered to the model without it.
func TestBuildArgsAddsPermissionPromptToolStdio(t *testing.T) {
	for _, in := range []provider.SessionStartInput{
		{},
		{Mode: provider.ModeFullAccess},
		{Mode: provider.ModeAuto},
		{Mode: provider.ModeAutoAcceptEdits},
		{Interact: provider.InteractionPlan},
	} {
		args := buildArgs(Config{}, in)
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--permission-prompt-tool stdio") {
			t.Fatalf("mode=%+v interact=%+v missing --permission-prompt-tool stdio; got: %s", in.Mode, in.Interact, joined)
		}
	}
}

// Two MCP transports can be wired into one session at once — Hindsight's
// own HTTP server (see internal/service/memory.go's MCPEndpoint) alongside
// `devdeck mcp-server` spawned over stdio (see internal/issuemcp) — and
// buildArgs must serialize both correctly into the single --mcp-config JSON
// blob the CLI accepts (main.go's mcpEndpointsFor builds exactly this
// slice).
func TestBuildArgsBuildsMCPConfigForMultipleEndpoints(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		MCPEndpoints: []provider.MCPEndpoint{
			{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test"},
			{Name: "devdeck", Command: "/path/to/devdeck", Args: []string{"mcp-server", "--db", "/path/to/devdeck.db"}},
		},
	})

	var raw string
	for i, a := range args {
		if a == "--mcp-config" && i+1 < len(args) {
			raw = args[i+1]
		}
	}
	if raw == "" {
		t.Fatalf("--mcp-config not found in args: %v", args)
	}

	var cfg struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("--mcp-config is not valid JSON: %v\nraw: %s", err, raw)
	}

	hs, ok := cfg.MCPServers["hindsight"]
	if !ok {
		t.Fatalf("mcpServers missing hindsight entry: %+v", cfg.MCPServers)
	}
	if hs.Type != "http" || hs.URL != "http://127.0.0.1:8888/mcp/devdeck/" || hs.Headers["Authorization"] != "Bearer hsk_test" {
		t.Fatalf("hindsight entry wrong shape: %+v", hs)
	}

	dd, ok := cfg.MCPServers["devdeck"]
	if !ok {
		t.Fatalf("mcpServers missing devdeck entry: %+v", cfg.MCPServers)
	}
	if dd.Command != "/path/to/devdeck" || strings.Join(dd.Args, " ") != "mcp-server --db /path/to/devdeck.db" {
		t.Fatalf("devdeck entry wrong shape: %+v", dd)
	}
	if dd.Type != "" || dd.URL != "" {
		t.Fatalf("a stdio entry must not also carry http fields: %+v", dd)
	}
}

func TestBuildArgsOmitsMCPConfigWhenNoEndpoints(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{})
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--mcp-config") {
		t.Fatalf("buildArgs must not emit --mcp-config with no endpoints; got: %s", joined)
	}
}

// RespondToUserInput is the real, wire-writing implementation. The original
// questions array must be echoed back verbatim (spec §1.5) alongside the
// answers, and a second call against an already-resolved request must be a
// silent no-op, not a second stdin write.
func TestRespondToUserInputEchoesOriginalQuestionsAndAnswers(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	st.setPending("req-1", &pendingRequest{
		requestID: "req-1", toolUseID: "toolu_1", toolName: "AskUserQuestion",
		kind:  pendingKindUserInput,
		input: json.RawMessage(`[{"question":"Tabs or spaces?","header":"H","options":[],"multiSelect":false}]`),
	})
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}

	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}
	if err := a.RespondToUserInput(context.Background(), "w-abc", "req-1", map[string]any{"Tabs or spaces?": "Tabs"}); err != nil {
		t.Fatalf("RespondToUserInput: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(buf.Bytes(), &wire); err != nil {
		t.Fatalf("stdin write is not JSON: %v (%s)", err, buf.String())
	}
	resp := wire["response"].(map[string]any)
	if resp["request_id"] != "req-1" {
		t.Fatalf("request_id = %v, want req-1", resp["request_id"])
	}
	inner := resp["response"].(map[string]any)
	if inner["behavior"] != "allow" {
		t.Fatalf("behavior = %v, want allow", inner["behavior"])
	}
	updated := inner["updatedInput"].(map[string]any)
	if updated["questions"] == nil {
		t.Fatal("updatedInput.questions must echo the original array")
	}
	answers := updated["answers"].(map[string]any)
	if answers["Tabs or spaces?"] != "Tabs" {
		t.Fatalf("answers = %v", answers)
	}

	// The pending entry must be retired — a second respond is a no-op, not
	// a second stdin write.
	buf.Reset()
	if err := a.RespondToUserInput(context.Background(), "w-abc", "req-1", map[string]any{}); err != nil {
		t.Fatalf("second respond: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("second respond wrote to stdin, want no-op: %s", buf.String())
	}
}

func TestRespondToUserInputOnUnknownThreadIsANoop(t *testing.T) {
	a := &adapter{sessions: map[string]*session{}, events: make(chan event.Event, 1)}
	if err := a.RespondToUserInput(context.Background(), "w-nope", "req-1", nil); err != nil {
		t.Fatalf("unknown thread must be a benign no-op, got: %v", err)
	}
}

// THE high-risk assertion for this package: the capture measured NO CLI-side
// timeout on an unanswered control_request (57s, unanswered — e10). A request
// class that reaches the adapter with no way to answer it hangs the session
// forever, silently.
//
// A1 satisfied that invariant by auto-denying every tool it did not route.
// A2 replaced the mechanism, on purpose: an ordinary tool now opens a REAL
// approval request the operator decides. The invariant is unchanged, so this
// test is re-pointed rather than deleted — it now proves the request stays
// ANSWERABLE end to end, which is what "never hangs" means once a human is in
// the loop. It deliberately uses a tool name the parser never special-cases
// (not AskUserQuestion, not ExitPlanMode), so it proves the general path and
// not a per-tool branch.
func TestUnhandledToolOpensAnAnswerableApprovalInsteadOfHanging(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{
		instanceID: "claude:default",
		events:     make(chan event.Event, 4),
		sessions:   map[string]*session{"w-abc": sess},
	}

	line := []byte(`{"type":"control_request","request_id":"req-unhandled","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_bash"}}`)
	var opened bool
	for _, ev := range parseLine(line, sess.state) {
		if ev.Type == event.RequestOpened && ev.RequestID == "req-unhandled" {
			opened = true
		}
		a.emit(ev)
	}
	// Step one of the invariant: the operator has to be able to SEE it. A
	// request held silently is indistinguishable from a hung session.
	if !opened {
		t.Fatal("no request.opened event — nothing would ever prompt the operator")
	}

	// A2 does not answer this from the parser, so nothing may have been
	// written yet. Writing here would mean deciding on the operator's behalf.
	a.drainAutoDenies(sess)
	if buf.Len() != 0 {
		t.Fatalf("parser answered on its own: %s", buf.String())
	}

	// Step two: the operator's decision must actually reach the CLI, keyed by
	// the id it is blocked on. This is the half that turns "waiting" into
	// "answered" rather than "hung".
	if err := a.RespondToRequest(context.Background(), "w-abc", "req-unhandled", event.DecisionDecline); err != nil {
		t.Fatalf("RespondToRequest: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(buf.Bytes(), &wire); err != nil {
		t.Fatalf("stdin write is not JSON: %v (%s) — the request was left unanswered", err, buf.String())
	}
	resp := wire["response"].(map[string]any)
	if resp["request_id"] != "req-unhandled" {
		t.Fatalf("request_id = %v, want req-unhandled — the CLI matches replies by id", resp["request_id"])
	}
	inner := resp["response"].(map[string]any)
	if inner["behavior"] != "deny" {
		t.Fatalf("behavior = %v, want deny", inner["behavior"])
	}
}

// SendTurn must fold each image attachment into the stdin message's content
// array as a base64 block, alongside the existing text block — the wire
// shape claude's CLI expects (spec §"C1", t3code's ClaudeAdapter.ts
// buildClaudeImageContentBlock). Uses the same capture-stdin-into-a-buffer
// harness as TestRespondToUserInputEchoesOriginalQuestionsAndAnswers /
// TestRespondToRequestWritesTheMappedDecisionAndRetiresPending above.
func TestSendTurn_WithImageAttachment_BuildsContentArray(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}

	imgBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	in := provider.SendTurnInput{
		ThreadID: "w-abc",
		TurnID:   "t-1",
		Text:     "look at this",
		Attachments: []provider.Attachment{
			{Kind: "image", MIME: "image/png", Data: imgBytes},
		},
	}
	if _, err := a.SendTurn(context.Background(), in); err != nil {
		t.Fatalf("SendTurn: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(buf.Bytes(), &wire); err != nil {
		t.Fatalf("stdin write is not JSON: %v (%s)", err, buf.String())
	}
	msg := wire["message"].(map[string]any)
	content, ok := msg["content"].([]any)
	if !ok {
		t.Fatalf("content is not an array: %#v", msg["content"])
	}
	if len(content) != 2 {
		t.Fatalf("content length = %d, want 2 (text + image): %#v", len(content), content)
	}

	textBlock := content[0].(map[string]any)
	if textBlock["type"] != "text" || textBlock["text"] != "look at this" {
		t.Fatalf("unexpected text block: %#v", textBlock)
	}

	imageBlock := content[1].(map[string]any)
	if imageBlock["type"] != "image" {
		t.Fatalf("unexpected image block: %#v", imageBlock)
	}
	source, ok := imageBlock["source"].(map[string]any)
	if !ok {
		t.Fatalf("image block missing source: %#v", imageBlock)
	}
	wantData := base64.StdEncoding.EncodeToString(imgBytes)
	if source["type"] != "base64" || source["media_type"] != "image/png" || source["data"] != wantData {
		t.Fatalf("unexpected image source: %#v", source)
	}
}

// A MIME type outside claude's allow-list must fail the turn outright — no
// silently-dropped attachment, and (checked explicitly) no stdin write at
// all, so a bad attachment cannot leave a half-formed message on the wire.
func TestSendTurn_UnsupportedMIME_FailsTurn(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}

	in := provider.SendTurnInput{
		ThreadID: "w-abc",
		TurnID:   "t-1",
		Text:     "look at this",
		Attachments: []provider.Attachment{
			{Kind: "image", MIME: "image/svg+xml", Data: []byte("<svg></svg>")},
		},
	}
	if _, err := a.SendTurn(context.Background(), in); err == nil {
		t.Fatal("SendTurn should fail for an unsupported attachment MIME type")
	}
	if buf.Len() != 0 {
		t.Fatalf("stdin was written despite the unsupported MIME type: %s", buf.String())
	}
}

// The composer's model pill was decorative on any thread that had already
// started: `--model` is a session-START flag (buildArgs), and the session
// starts on thread.created — before the operator has picked anything. Every
// later pick was dropped, so a thread silently kept running whatever model it
// was born with.
//
// The CLI's own `set_model` control request is the fix, verified live against
// 2.1.233: with it the session's reported model changed from claude-opus-5[1m]
// to the requested one; without it, it did not.
func TestSendTurnSwitchesTheModelWhenThePickChanges(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	sess := &session{
		threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st,
		model: "claude-opus-4-8",
	}
	a := &adapter{
		instanceID: "claude:default",
		events:     make(chan event.Event, 8),
		sessions:   map[string]*session{"w-abc": sess},
	}

	if _, err := a.SendTurn(context.Background(), provider.SendTurnInput{
		ThreadID: "w-abc", TurnID: "t-1", Text: "hi",
		Model: provider.ModelSelection{Model: "claude-sonnet-5"},
	}); err != nil {
		t.Fatalf("SendTurn: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 stdin writes (set_model then the message), got %d: %q", len(lines), buf.String())
	}

	var ctrl map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &ctrl); err != nil {
		t.Fatalf("first write is not JSON: %v (%s)", err, lines[0])
	}
	if ctrl["type"] != "control_request" {
		t.Fatalf("first write type = %v, want control_request — the switch must precede the message", ctrl["type"])
	}
	req := ctrl["request"].(map[string]any)
	if req["subtype"] != "set_model" {
		t.Fatalf("subtype = %v, want set_model", req["subtype"])
	}
	if req["model"] != "claude-sonnet-5" {
		t.Fatalf("model = %v, want the model the operator picked", req["model"])
	}
	if ctrl["request_id"] == "" || ctrl["request_id"] == nil {
		t.Fatal("control_request needs a request_id — the CLI answers by id")
	}
	// The session must remember it, or every later turn re-sends the switch.
	if sess.model != "claude-sonnet-5" {
		t.Fatalf("sess.model = %q, want the new model recorded", sess.model)
	}

	var msg map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &msg); err != nil {
		t.Fatalf("second write is not JSON: %v", err)
	}
	if msg["type"] != "user" {
		t.Fatalf("second write type = %v, want the user message", msg["type"])
	}
}

// The switch is not free — it is a round trip the CLI has to process — so it
// must only happen when the pick actually differs. An unchanged model, or a
// turn that carries none at all (meaning "leave the session alone"), writes
// the message and nothing else.
func TestSendTurnDoesNotResendAnUnchangedModel(t *testing.T) {
	for _, tc := range []struct {
		name string
		sel  provider.ModelSelection
	}{
		{"same model", provider.ModelSelection{Model: "claude-opus-4-8"}},
		{"no model on the turn", provider.ModelSelection{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			st := newParseState("w-abc", "claude:default")
			sess := &session{
				threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st,
				model: "claude-opus-4-8",
			}
			a := &adapter{
				instanceID: "claude:default",
				events:     make(chan event.Event, 8),
				sessions:   map[string]*session{"w-abc": sess},
			}

			if _, err := a.SendTurn(context.Background(), provider.SendTurnInput{
				ThreadID: "w-abc", TurnID: "t-1", Text: "hi", Model: tc.sel,
			}); err != nil {
				t.Fatalf("SendTurn: %v", err)
			}

			lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
			if len(lines) != 1 {
				t.Fatalf("want exactly the user message, got %d writes: %q", len(lines), buf.String())
			}
			if sess.model != "claude-opus-4-8" {
				t.Fatalf("sess.model = %q, must not drift", sess.model)
			}
		})
	}
}
