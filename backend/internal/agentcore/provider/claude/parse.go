// Package claude turns the Claude CLI's `stream-json` NDJSON transport into
// canonical runtime events:
//
//	claude --print --output-format stream-json --input-format stream-json \
//	       --include-partial-messages
//
// This is the riskiest code in spec 1 (see gg/HANDOFF.md section 8 and
// docs/superpowers/specs/2026-08-07-agent-chat-pane-design.md "Risks"):
// `stream-json` is not a stable, versioned wire format — it is whatever the
// currently-installed CLI happens to emit, and it has changed shape across
// releases before. The fixture in testdata/turn.ndjson was captured live
// against `claude --version` == 2.1.224 (Claude Code). Whenever that fixture
// is recaptured against a newer CLI, re-run the tests in parse_test.go and
// update the mapping below to match what actually changed — never guess at
// the new shape from memory.
//
// testdata/plan.ndjson is a second, separately captured fixture — CLI
// 2.1.233 — covering only the ExitPlanMode plan-capture path (parseAssistant
// and parseControlRequest's ExitPlanMode branch, docs/superpowers/specs/
// 2026-08-15-composer-plan-surface-design.md §1). Recapture that fixture
// specifically, not testdata/turn.ndjson, if the plan-capture shape changes.
//
// The mitigation for that instability is structural, not aspirational: every
// message shape this file does not recognize becomes a single
// event.RuntimeWarning carrying the original bytes in Raw, never a crash and
// never a silent drop. The next CLI release WILL ship a message type this
// file has never seen; that must degrade gracefully, not take the session
// down.
package claude

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// parseState carries everything parseLine needs across the NDJSON lines of
// one adapter session.
type parseState struct {
	threadID   string
	instanceID provider.InstanceID

	// turnID is stamped onto every event emitted while a turn is in flight.
	// The parser never invents one — the adapter calls setTurnID with the
	// DevDeck-owned turn id when it sends a turn to the CLI.
	turnID string

	// sessionID is Claude's native session UUID. It lives in Refs only and
	// is never used as orchestration identity — see event.Refs.
	sessionID string

	// currentMessageID is the native id of the in-flight assistant message,
	// captured from stream_event/message_start. Content-block "index" is
	// only unique WITHIN one message: the captured fixture shows the CLI
	// start a second message (reusing index 0) after a mid-turn
	// model-refusal fallback retried the request against a different model.
	// So the stable item key is (message id, index), not index alone.
	currentMessageID string

	// blockKind records the native content-block type ("text" | "thinking" |
	// "tool_use") by index, set at content_block_start and read again at
	// content_block_stop to decide whether the block needs an ItemCompleted.
	blockKind map[int]string

	// blockInput accumulates a tool_use block's streamed `input_json_delta`
	// fragments by index, so ItemCompleted can carry the full tool call
	// arguments once content_block_stop arrives.
	blockInput map[int][]byte

	// blockToolName records a tool_use content block's native tool name by
	// index, set at content_block_start. blockKind alone ("tool_use") is not
	// enough to single out ExitPlanMode's block for the §1.4 dead-row skip —
	// stopContentBlock needs the name too.
	blockToolName map[int]string

	// capturedPlans dedupes TurnProposedCompleted, keyed exactly as t3code's
	// exitPlanCaptureKey: "tool:<toolUseId>" when a tool-use id is present,
	// else "plan:<markdown>" (ClaudeAdapter.ts:1391-1399). The same plan
	// arrives on both the "assistant" line and its paired control_request
	// (design.md §1.2) — this is what makes capturing it from both places
	// safe. Session-scoped and never cleared: a second proposed plan later in
	// the same thread gets a second tool_use_id and is captured again.
	capturedPlans map[string]bool

	// seq holds the per-(itemID, StreamKind) delta counters. Sequence MUST
	// be monotonic per item+stream — the client uses it to detect a delta
	// that was dropped or arrived out of order.
	seq map[string]uint64

	// mu guards pending and autoDenies: written by readLoop's goroutine as
	// control_request/control_cancel_request lines arrive, and read/deleted
	// by the Reactor's goroutine via the adapter's RespondToUserInput (and,
	// in A2, RespondToRequest).
	mu sync.Mutex

	// pending holds provider-specific metadata for every control_request
	// awaiting an answer, keyed by the CLI's top-level request_id. Never
	// leaves this package — see event.go's no-leak rule (event.go:6-10).
	pending map[string]*pendingRequest

	// autoDenies queues deny replies this parser decided on its own (every
	// can_use_tool it does not yet route to a real decision, including
	// ExitPlanMode) for the adapter's readLoop to write back over stdin.
	autoDenies []autoDenyReply
}

// newParseState creates parser state scoped to one adapter session. threadID
// and instanceID are stamped onto every event this state produces because
// orchestration routes exclusively on InstanceID, never on Kind — a missing
// or wrong InstanceID here stays invisible until a second instance of the
// same provider exists, at which point it is an expensive bug to find (see
// the InstanceID comment in provider/provider.go).
func newParseState(threadID string, instanceID provider.InstanceID) *parseState {
	return &parseState{
		threadID:      threadID,
		instanceID:    instanceID,
		blockKind:     make(map[int]string),
		blockInput:    make(map[int][]byte),
		blockToolName: make(map[int]string),
		capturedPlans: make(map[string]bool),
		seq:           make(map[string]uint64),
	}
}

// setTurnID records the DevDeck-owned turn id for events parsed while that
// turn is in flight. Called by the adapter (Task 8) right before it writes
// the turn to the CLI's stdin.
func (st *parseState) setTurnID(id string) { st.turnID = id }

func (st *parseState) nextSeq(itemID string, stream event.StreamKind) uint64 {
	key := itemID + "|" + string(stream)
	st.seq[key]++
	return st.seq[key]
}

func (st *parseState) itemID(index int) string {
	return st.currentMessageID + "#" + strconv.Itoa(index)
}

// refs builds the envelope's provider-native id block, or nil before any
// session/init message has been seen. Refs is the ONLY place a native id may
// live — orchestration must never be handed a Claude session UUID as if it
// were a DevDeck id.
func (st *parseState) refs() *event.Refs {
	if st.sessionID == "" {
		return nil
	}
	return &event.Refs{SessionID: st.sessionID}
}

// envelope stamps the fields every event this package produces must carry:
// Provider, InstanceID, ThreadID, and CreatedAt. parseLine has no `now`
// parameter (unlike orchestration.Decide) because this function is already
// impure by nature — it is translating live process output, not deciding
// business rules — so time.Now() belongs here.
func (st *parseState) envelope(typ event.Type) event.Event {
	return event.Event{
		Type:       typ,
		Provider:   "claude",
		InstanceID: string(st.instanceID),
		ThreadID:   st.threadID,
		TurnID:     st.turnID,
		CreatedAt:  time.Now().UTC(),
		Refs:       st.refs(),
	}
}

// warning builds the one-event fallback for anything this parser cannot (or
// deliberately does not yet) make sense of. raw is stored verbatim in
// Raw.Payload for debugging — and, per event.Raw's contract, must never be
// branched on by any other code.
func warning(st *parseState, message string, raw []byte, method string) []event.Event {
	e := st.envelope(event.RuntimeWarning)
	e.Payload = &event.WarningPayload{Message: message}
	e.Raw = &event.Raw{Source: "claude.cli", Method: method, Payload: append([]byte(nil), raw...)}
	return []event.Event{e}
}

// wireLine is a loose decode of one NDJSON line. Only the fields this parser
// acts on are typed; every byte of the line is preserved untouched in Raw
// for the warning/debug path, so a field this struct does not know about is
// never silently lost.
type wireLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	IsError   bool            `json:"is_error"`
	Usage     json.RawMessage `json:"usage"`
	Event     json.RawMessage `json:"event"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
}

// controlRequestBody is the nested `"request"` object on
// `"type":"control_request"` lines — the CLI's `--permission-prompt-tool
// stdio` control channel (gg/HANDOFF.md section 6).
type controlRequestBody struct {
	Subtype                 string          `json:"subtype"`
	ToolName                string          `json:"tool_name"`
	Input                   json.RawMessage `json:"input"`
	Description             string          `json:"description"`
	PermissionSuggestions   json.RawMessage `json:"permission_suggestions"`
	ToolUseID               string          `json:"tool_use_id"`
	RequiresUserInteraction bool            `json:"requires_user_interaction"`
	BlockedPath             string          `json:"blocked_path"`
}

// parseLine turns one NDJSON line into zero or more canonical events. It
// never panics and never returns an error: a line this parser cannot make
// sense of becomes a runtime.warning event instead, because a parser that
// crashes on the next stream-json shape change takes the whole agent session
// down with it.
func parseLine(line []byte, st *parseState) []event.Event {
	var w wireLine
	if err := json.Unmarshal(line, &w); err != nil {
		return warning(st, "malformed JSON from claude CLI: "+err.Error(), line, "")
	}

	switch w.Type {
	case "system":
		return parseSystem(w, st, line)
	case "stream_event":
		return parseStreamEvent(w, st, line)
	case "result":
		return parseResult(w, st, line)
	case "control_request":
		return parseControlRequest(w, st, line)
	case "control_cancel_request":
		return parseControlCancelRequest(w, st)
	case "assistant":
		// Scans the message's content for an ExitPlanMode tool_use block —
		// see parseAssistant (design.md §1.1). Every other "assistant" line
		// still contributes nothing: it duplicates content already streamed
		// via content_block_delta, same as "user" below.
		return parseAssistant(st, line)
	case "user", "rate_limit_event", "control_response",
		"tool_progress", "tool_use_summary", "auth_status", "autocompact_state":
		// Recognized shapes, deliberately not mapped to a canonical event:
		// "user" duplicates content already streamed via content_block_delta,
		// rate-limit telemetry has no CORE payload type yet, and
		// "control_response" is the CLI's ack of a control_response WE sent
		// (the interrupt-ack shape, capture e10) — it must not assume
		// request_id is present (e10's second line has none). This is
		// understood, not unparseable, so it is not a warning — see the
		// package comment for the distinction this file draws between
		// "ignored on purpose" and "never seen before".
		//
		// The four added here are progress/telemetry frames, and the source
		// for that is the CLI's OWN reference consumer rather than a guess:
		// `strings` on the 2.1.234 binary shows its `sdkMessageAdapter`
		// carrying an explicit ignore list —
		//
		//   [sdkMessageAdapter] Ignoring heartbeat/subagent-retry tool_progress frame
		//   [sdkMessageAdapter] Ignoring tool_use_summary message
		//   [sdkMessageAdapter] Ignoring auth_status message
		//   [sdkMessageAdapter] Ignoring rate_limit_event message
		//
		// — beside the same "Unknown message type:" fallback this switch has.
		// So the official SDK drops these too, and DevDeck warning about them
		// was not caution, it was noise: `tool_progress` fires repeatedly
		// during any long tool call, and once runtime warnings became visible
		// in the transcript (they used to be dropped by the client entirely)
		// every such call buried the turn under identical notices.
		//
		// `tool_progress` is the one with real content — the binary shows
		// `repl_call`, `heartbeat` and `subagent_retry` variants. Nothing in
		// DevDeck can show tool progress yet, and the tool row already reads
		// "running", so it is dropped whole rather than half-mapped. That is
		// a UI gap to close later, not a parse failure.
		return nil
	default:
		// Anything else falls through to a warning rather than silent
		// silence — a message shape this file has never seen must be
		// visible (as a warning carrying Raw) rather than hanging with zero
		// signal in the UI.
		return warning(st, fmt.Sprintf("unrecognized message type %q", w.Type), line, w.Type)
	}
}

type pendingKind int

const (
	pendingKindUserInput pendingKind = iota
	pendingKindApproval
)

// pendingRequest is the provider-specific metadata a decision needs to be
// echoed back to the CLI. It never leaves this package — see event.go's
// no-leak rule (event.go:6-10). A1 only ever creates pendingKindUserInput
// entries; A2 (T11) extends this to pendingKindApproval for ordinary tools.
type pendingRequest struct {
	requestID   string
	toolUseID   string
	toolName    string
	kind        pendingKind
	requestType event.RequestType
	// input is the ORIGINAL, unmodified bytes the CLI sent — for a question,
	// input.questions verbatim (never DevDeck's normalized version — the SDK
	// looks answers up by the text it sent, and echoing our own reshaping
	// risks dropping a field the CLI still expects).
	input       json.RawMessage
	suggestions json.RawMessage // A2 only
}

type autoDenyReply struct {
	requestID string
	message   string
}

func (st *parseState) setPending(id string, p *pendingRequest) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.pending == nil {
		st.pending = make(map[string]*pendingRequest)
	}
	st.pending[id] = p
}

func (st *parseState) takePending(id string) (*pendingRequest, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	p, ok := st.pending[id]
	if ok {
		delete(st.pending, id)
	}
	return p, ok
}

func (st *parseState) queueAutoDeny(requestID, message string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.autoDenies = append(st.autoDenies, autoDenyReply{requestID: requestID, message: message})
}

func (st *parseState) takeAutoDenies() []autoDenyReply {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := st.autoDenies
	st.autoDenies = nil
	return out
}

const (
	planCapturedDenyMessage = "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn."
	// Sent for a control_request this parser does not understand at all. It
	// is not a permission decision — it is the only way to hand the CLI back
	// a reply it can match, so the turn continues instead of blocking.
	unhandledDenyMessage = "DevDeck does not understand this request and cannot act on it. Continue without it."
)

// exitPlanModeInput is the `input` object an ExitPlanMode tool_use/
// can_use_tool request carries: the plan markdown and the agent-host path
// the CLI wrote it to (~/.claude/plans/<slug>.md — metadata only, design.md
// Non-goals).
type exitPlanModeInput struct {
	Plan         string `json:"plan"`
	PlanFilePath string `json:"planFilePath"`
}

// extractExitPlanModePlan mirrors t3code's extractExitPlanModePlan
// (ClaudeAdapter.ts:1379-1389): a present, non-blank `plan` string, trimmed —
// trim-then-check, not just non-empty-check, so a whitespace-only value
// still counts as absent. A missing key, the wrong JSON type, or a
// malformed `input` all return ok=false rather than erroring, the same
// "recognized, not mapped" contract every other extractor in this file
// follows.
func extractExitPlanModePlan(input json.RawMessage) (plan string, ok bool) {
	var in exitPlanModeInput
	if err := json.Unmarshal(input, &in); err != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(in.Plan)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// exitPlanModeFilePath reads `planFilePath` off the same `input` object,
// best-effort — it is metadata only, so a decode failure just leaves it
// empty rather than suppressing the plan itself.
func exitPlanModeFilePath(input json.RawMessage) string {
	var in exitPlanModeInput
	_ = json.Unmarshal(input, &in)
	return in.PlanFilePath
}

// exitPlanCaptureKey mirrors t3code's exitPlanCaptureKey
// (ClaudeAdapter.ts:1392-1399) — see parseState.capturedPlans.
func exitPlanCaptureKey(toolUseID, planMarkdown string) string {
	if toolUseID != "" {
		return "tool:" + toolUseID
	}
	return "plan:" + planMarkdown
}

// captureProposedPlan records planMarkdown as captured under toolUseID's
// key, returning true the first time this exact plan is seen and false on
// every repeat. Both the "assistant" line and its paired control_request
// call this for the same tool_use_id (design.md §1.2) — only the first one
// to run wins.
func (st *parseState) captureProposedPlan(toolUseID, planMarkdown string) bool {
	key := exitPlanCaptureKey(toolUseID, planMarkdown)
	if st.capturedPlans[key] {
		return false
	}
	st.capturedPlans[key] = true
	return true
}

// proposedPlanEvent builds the canonical TurnProposedCompleted event. The
// tool_use_id lives in Refs.CallID, same as every other tool-scoped event
// this package emits (withCallID) — never as orchestration identity.
func (st *parseState) proposedPlanEvent(toolUseID, planMarkdown, planFilePath string) event.Event {
	e := st.envelope(event.TurnProposedCompleted)
	e.Refs = withCallID(e.Refs, toolUseID)
	e.Payload = &event.ProposedPlanPayload{
		PlanMarkdown: planMarkdown,
		PlanFilePath: planFilePath,
		ToolUseID:    toolUseID,
	}
	return e
}

// assistantMessage is the nested `"message"` object on `"type":"assistant"`
// lines — decoded only far enough to find an ExitPlanMode tool_use block.
type assistantMessage struct {
	Content []assistantContentBlock `json:"content"`
}

type assistantContentBlock struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// parseAssistant scans a "type":"assistant" line's content blocks for an
// ExitPlanMode tool_use — the primary path the plan markdown arrives on
// (design.md §1.1). ExitPlanMode's content block streams zero bytes of
// input_json_delta (verified live, capture m_stdio_plan lines 139-143), so
// this line — not startContentBlock/stopContentBlock — is the only place
// the plan text exists. Any assistant line without one produces no event,
// preserving the "deliberately not mapped" contract the rest of this line
// type has.
func parseAssistant(st *parseState, raw []byte) []event.Event {
	var body struct {
		Message assistantMessage `json:"message"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}

	var evts []event.Event
	for _, block := range body.Message.Content {
		if block.Type != "tool_use" || block.Name != "ExitPlanMode" {
			continue
		}
		plan, ok := extractExitPlanModePlan(block.Input)
		if !ok {
			continue
		}
		if !st.captureProposedPlan(block.ID, plan) {
			continue
		}
		evts = append(evts, st.proposedPlanEvent(block.ID, plan, exitPlanModeFilePath(block.Input)))
	}
	return evts
}

// parseControlRequest handles "type":"control_request" lines — the approval
// and user-input control channel (gg/HANDOFF.md section 6). Three outcomes:
// AskUserQuestion becomes event.UserInputRequested; ExitPlanMode is
// auto-denied immediately, queued for readLoop to write back over stdin (see
// T2) and reported as event.ToolDenied so the denial is visible in the
// transcript instead of invisible, which is what today's silent-denial mode
// does (spec §0, Correction 1); every other can_use_tool becomes a real
// event.RequestOpened, classified per spec §4.4, with its pendingRequest
// registered so a later decision (T12's RespondToRequest) or cancellation
// can find it.
func parseControlRequest(w wireLine, st *parseState, raw []byte) []event.Event {
	// The CLI blocks on every control_request until a control_response echoes
	// its id, and the capture measured no CLI-side timeout. So each branch
	// below has to leave a reply behind, not merely a warning — warning alone
	// is what "the session froze and nothing said why" looks like. The one
	// exception is a request with no id: there is nothing to echo, so it can
	// only be reported.
	answerable := w.RequestID != ""

	var body controlRequestBody
	if err := json.Unmarshal(w.Request, &body); err != nil {
		if answerable {
			st.queueAutoDeny(w.RequestID, unhandledDenyMessage)
		}
		return warning(st, "malformed control_request: "+err.Error(), raw, "control_request")
	}
	if body.Subtype != "can_use_tool" {
		// set_permission_mode, set_model, request_user_dialog, and anything
		// else the CLI's embedded schema documents: understood to exist,
		// deliberately not built (spec's Non-goals) — one warning, and a reply
		// so the turn survives not building it.
		if answerable {
			st.queueAutoDeny(w.RequestID, unhandledDenyMessage)
		}
		return warning(st, fmt.Sprintf("unrecognized control_request subtype %q", body.Subtype), raw, "control_request")
	}
	if !answerable {
		return warning(st, "control_request missing top-level request_id", raw, "control_request")
	}

	switch body.ToolName {
	case "AskUserQuestion":
		var qin struct {
			Questions json.RawMessage `json:"questions"`
		}
		_ = json.Unmarshal(body.Input, &qin)
		st.setPending(w.RequestID, &pendingRequest{
			requestID: w.RequestID, toolUseID: body.ToolUseID, toolName: body.ToolName,
			kind: pendingKindUserInput, requestType: event.ReqToolUserInput,
			input: qin.Questions,
		})
		e := st.envelope(event.UserInputRequested)
		e.RequestID = w.RequestID
		e.Refs = withCallID(e.Refs, body.ToolUseID)
		e.Payload = &event.UserInputRequestedPayload{Questions: normalizeUserInputQuestions(qin.Questions)}
		return []event.Event{e}

	case "ExitPlanMode":
		st.queueAutoDeny(w.RequestID, planCapturedDenyMessage)
		e := st.envelope(event.ToolDenied)
		e.RequestID = w.RequestID
		e.Payload = &event.ToolDeniedPayload{ToolName: body.ToolName, Message: planCapturedDenyMessage}
		evts := []event.Event{e}
		// §1.2: redundancy inside this control_request path. The capture
		// shows the "assistant" line for a shared tool_use_id arriving
		// FIRST, so in practice captureProposedPlan below is always a
		// dedupe no-op here — this exists for a CLI release that reorders
		// or drops the plan from the assistant line, not as the primary
		// path (that is parseAssistant, §1.1).
		if plan, ok := extractExitPlanModePlan(body.Input); ok && st.captureProposedPlan(body.ToolUseID, plan) {
			evts = append(evts, st.proposedPlanEvent(body.ToolUseID, plan, exitPlanModeFilePath(body.Input)))
		}
		return evts

	default:
		// A2: every other can_use_tool becomes a real approval request — the
		// broker (T10) and RespondToRequest (T12) answer it for real instead
		// of this parser auto-denying on the operator's behalf.
		requestType := classifyRequestType(body.ToolName)
		detail := body.Description
		if detail == "" {
			detail = summarizeToolRequest(body.ToolName, body.Input)
		}
		if body.BlockedPath != "" {
			detail = detail + " (blocked path: " + body.BlockedPath + ")"
		}
		options := []event.Decision{event.DecisionAccept, event.DecisionDecline, event.DecisionCancel}
		if len(body.PermissionSuggestions) > 0 && string(body.PermissionSuggestions) != "null" {
			// acceptForSession is only offered when the CLI actually sent
			// something to echo back as updatedPermissions — withholding it
			// otherwise is what stops "always allow this session" from
			// silently degrading to "allow once" (spec §4.3).
			options = append(options, event.DecisionAcceptForSession)
		}

		st.setPending(w.RequestID, &pendingRequest{
			requestID: w.RequestID, toolUseID: body.ToolUseID, toolName: body.ToolName,
			kind: pendingKindApproval, requestType: requestType,
			input: body.Input, suggestions: body.PermissionSuggestions,
		})

		e := st.envelope(event.RequestOpened)
		e.RequestID = w.RequestID
		e.Refs = withCallID(e.Refs, body.ToolUseID)
		e.Payload = &event.RequestOpenedPayload{
			RequestType: requestType, Detail: detail, Args: body.Input, Options: options,
		}
		return []event.Event{e}
	}
}

// classifyRequestType maps a can_use_tool's tool_name to the canonical
// event.RequestType the client renders on (spec §4.4).
func classifyRequestType(toolName string) event.RequestType {
	switch toolName {
	case "Bash":
		return event.ReqCommandExecApproval
	case "Write", "Edit", "NotebookEdit":
		return event.ReqFileChangeApproval
	case "Read":
		return event.ReqFileReadApproval
	default:
		return event.ReqUnknown
	}
}

// summarizeToolRequest is t3code's per-tool one-line fallback
// (ClaudeAdapter.ts) for when the CLI sends no `description`.
func summarizeToolRequest(toolName string, input json.RawMessage) string {
	switch toolName {
	case "Bash":
		var in struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(input, &in)
		if in.Command != "" {
			return in.Command
		}
	case "Write", "Edit":
		var in struct {
			FilePath string `json:"file_path"`
		}
		_ = json.Unmarshal(input, &in)
		if in.FilePath != "" {
			return in.FilePath
		}
	}
	return toolName
}

// withCallID copies refs (nil-safe) and stamps CallID — Refs is the ONLY
// place a native id may live (event.go:121-132).
func withCallID(refs *event.Refs, callID string) *event.Refs {
	out := event.Refs{}
	if refs != nil {
		out = *refs
	}
	out.CallID = callID
	return &out
}

// parseControlCancelRequest retires whatever pending entry the CLI just
// cancelled — the CLI sends this itself when an interrupt lands on a pending
// prompt (spec §0 "Cancellation", capture e10_int_pending). A1 can only ever
// have a user-input entry pending; A2 (T11) extends this with the approval
// branch once approval entries exist.
func parseControlCancelRequest(w wireLine, st *parseState) []event.Event {
	if w.RequestID == "" {
		return nil
	}
	p, ok := st.takePending(w.RequestID)
	if !ok {
		return nil
	}
	if p.kind == pendingKindUserInput {
		e := st.envelope(event.UserInputResolved)
		e.RequestID = w.RequestID
		return []event.Event{e}
	}
	e := st.envelope(event.RequestResolved)
	e.RequestID = w.RequestID
	e.Payload = &event.RequestResolvedPayload{RequestType: p.requestType, Decision: event.DecisionCancel}
	return []event.Event{e}
}

// normalizedQuestion mirrors t3code's own AskUserQuestion normalization
// (ClaudeAdapter.ts:3782-3789): every question gets a stable id (the
// question text itself, or a positional fallback) and a header, computed
// once here and never re-derived on the client.
type normalizedQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type normalizedQuestion struct {
	ID          string                     `json:"id"`
	Header      string                     `json:"header"`
	Question    string                     `json:"question"`
	Options     []normalizedQuestionOption `json:"options"`
	MultiSelect bool                       `json:"multiSelect"`
}

func normalizeUserInputQuestions(questions json.RawMessage) json.RawMessage {
	var raw []struct {
		Question string `json:"question"`
		Header   string `json:"header"`
		Options  []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"options"`
		MultiSelect bool `json:"multiSelect"`
	}
	_ = json.Unmarshal(questions, &raw)

	out := make([]normalizedQuestion, 0, len(raw))
	for idx, q := range raw {
		id := q.Question
		if id == "" {
			id = fmt.Sprintf("q-%d", idx)
		}
		header := q.Header
		if header == "" {
			header = fmt.Sprintf("Question %d", idx+1)
		}
		opts := make([]normalizedQuestionOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, normalizedQuestionOption{Label: o.Label, Description: o.Description})
		}
		out = append(out, normalizedQuestion{
			ID: id, Header: header, Question: q.Question, Options: opts, MultiSelect: q.MultiSelect,
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return json.RawMessage(`[]`)
	}
	return b
}

// systemNotice is the loose decode of the `"type":"system"` subtypes that
// carry a REASON a turn went wrong. Field names are the CLI's own
// stream-json spelling — snake_case on the wire, even though the same
// objects are camelCase inside the binary — and every one of them was read
// off the 2.1.234 binary's own emitters rather than guessed:
//
//	model_refusal_no_fallback  content, original_model, api_refusal_category,
//	                           api_refusal_explanation
//	model_refusal_fallback     + fallback_model, trigger, direction, scope
//	model_fallback             trigger, original_model, fallback_model, content
//	model_consent_fallback     choice, original_model, fallback_model, content
//	permission_denied          tool_name, tool_use_id, decision_reason, message
//	api_retry                  attempt, max_retries, retry_delay_ms,
//	                           error_status, error
//
// Everything is optional: a subtype that stops sending one of these degrades
// to a shorter sentence, never to a dropped event.
type systemNotice struct {
	Content               string `json:"content"`
	OriginalModel         string `json:"original_model"`
	FallbackModel         string `json:"fallback_model"`
	APIRefusalCategory    string `json:"api_refusal_category"`
	APIRefusalExplanation string `json:"api_refusal_explanation"`
	ToolName              string `json:"tool_name"`
	ToolUseID             string `json:"tool_use_id"`
	Message               string `json:"message"`
	DecisionReason        string `json:"decision_reason"`
	Attempt               int    `json:"attempt"`
	MaxRetries            int    `json:"max_retries"`
	ErrorStatus           *int   `json:"error_status"`
	// Error is already a short classification string on the wire
	// ("overloaded", "rate_limit", "authentication_failed", …) — the CLI runs
	// its raw error through a mapper before emitting it, so there is nothing
	// further to interpret here.
	Error string `json:"error"`
}

// firstNonBlank returns the first argument that is not blank after trimming,
// or "" when they all are. The notice subtypes overlap heavily in which field
// carries the human sentence, and which one is populated varies by CLI
// release — preferring in order beats branching per subtype.
func firstNonBlank(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

// parseSystem handles the CLI's `"type":"system"` lines.
//
// "init" is the session-start announcement. The other mapped subtypes below
// are the ones that say WHY a turn produced nothing, and dropping them is
// what made a safeguard refusal look like the agent simply going quiet:
// `model_refusal_no_fallback` ends the turn with zero output tokens and no
// assistant message at all, so unless this function speaks up the operator
// sees a turn go running -> idle with an empty transcript and no way to tell
// a refusal from a crash from a bug in DevDeck. That subtype carries the only
// copy of the explanation, including `api_refusal_category` (the CLI
// special-cases "cyber", which is exactly what an infrastructure/SSH question
// is liable to trip).
//
// Everything still unmapped — hook lifecycle chatter, status pings, compact
// boundaries, task/telemetry frames — stays recognized noise and returns nil,
// the same "ignored on purpose, not unparseable" contract parseLine's own
// switch draws.
func parseSystem(w wireLine, st *parseState, raw []byte) []event.Event {
	switch w.Subtype {
	case "init":
		if w.SessionID == "" {
			return warning(st, "system/init message missing session_id", raw, "system.init")
		}
		st.sessionID = w.SessionID
		resume, _ := json.Marshal(w.SessionID)
		e := st.envelope(event.SessionStarted)
		e.Payload = &event.SessionStartedPayload{Resume: resume}
		return []event.Event{e}

	case "model_refusal_no_fallback":
		// A real error, not a warning: the model declined and there was no
		// fallback to retry against, so this IS the turn's outcome. The turn
		// still settles through the normal "result" line afterwards — this only
		// adds the reason the transcript was otherwise missing.
		var n systemNotice
		_ = json.Unmarshal(raw, &n)
		e := st.envelope(event.RuntimeError)
		e.Payload = &event.ErrorPayload{
			Message: refusalMessage(n),
			Code:    firstNonBlank(n.APIRefusalCategory, "refusal"),
		}
		e.Raw = &event.Raw{Source: "claude.cli", Method: "system." + w.Subtype, Payload: append([]byte(nil), raw...)}
		return []event.Event{e}

	case "model_refusal_fallback", "model_fallback", "model_consent_fallback":
		// The request WAS retried — against a different model — so the turn is
		// still alive and this is a notice, not a failure. Without it the model
		// silently changes underneath the operator mid-turn.
		var n systemNotice
		_ = json.Unmarshal(raw, &n)
		msg := firstNonBlank(n.Content, refusalMessage(n))
		if msg == "" {
			msg = "The CLI switched models mid-turn."
		}
		if n.FallbackModel != "" && !strings.Contains(msg, n.FallbackModel) {
			msg += " (now running on " + n.FallbackModel + ")"
		}
		return noticeEvent(st, msg, raw, "system."+w.Subtype)

	case "permission_denied":
		// The CLI's OWN permission layer refused a tool — distinct from
		// parseControlRequest's auto-deny, which is DevDeck refusing. Before
		// this, an agent whose every tool call was denied by its settings
		// produced a turn that did nothing and explained nothing.
		var n systemNotice
		_ = json.Unmarshal(raw, &n)
		e := st.envelope(event.ToolDenied)
		if n.ToolUseID != "" {
			e.Refs = withCallID(e.Refs, n.ToolUseID)
		}
		e.Payload = &event.ToolDeniedPayload{
			ToolName: firstNonBlank(n.ToolName, "A tool"),
			Message:  firstNonBlank(n.Message, n.DecisionReason, "The agent's own permission settings denied it."),
		}
		e.Raw = &event.Raw{Source: "claude.cli", Method: "system.permission_denied", Payload: append([]byte(nil), raw...)}
		return []event.Event{e}

	case "api_retry":
		// Surfaced as a notice so a turn that stalls for a minute on an
		// overloaded/rate-limited API reads as "retrying", not as frozen.
		var n systemNotice
		_ = json.Unmarshal(raw, &n)
		msg := "The API call failed and is being retried"
		if n.MaxRetries > 0 {
			msg += fmt.Sprintf(" (attempt %d of %d)", n.Attempt, n.MaxRetries)
		}
		if reason := firstNonBlank(n.Error); reason != "" {
			msg += ": " + reason
		}
		if n.ErrorStatus != nil {
			msg += fmt.Sprintf(" [HTTP %d]", *n.ErrorStatus)
		}
		return noticeEvent(st, msg+".", raw, "system.api_retry")

	default:
		return nil
	}
}

// refusalMessage renders the operator-facing sentence for a refusal notice,
// preferring what the CLI wrote and falling back to a sentence built from the
// category when `content` is empty — which the binary's own
// model_refusal_no_fallback emitter does send (`content:""`) on at least one
// path, so an empty string here must not degrade to a blank error row.
func refusalMessage(n systemNotice) string {
	if msg := firstNonBlank(n.Content, n.APIRefusalExplanation); msg != "" {
		return msg
	}
	msg := "The model declined to answer this turn and no fallback model was available, so it produced no output."
	if n.APIRefusalCategory != "" {
		msg += " Refusal category: " + n.APIRefusalCategory + "."
	}
	if n.OriginalModel != "" {
		msg += " Model: " + n.OriginalModel + "."
	}
	return msg
}

// noticeEvent is warning()'s sibling for a shape this parser DOES understand
// but which carries no canonical payload of its own. Same RuntimeWarning
// event (the client renders it as a transcript notice, not an alarm), same
// Raw passthrough — the distinction is only in intent, so they deliberately
// produce the same wire shape.
func noticeEvent(st *parseState, message string, raw []byte, method string) []event.Event {
	e := st.envelope(event.RuntimeWarning)
	e.Payload = &event.WarningPayload{Message: message}
	e.Raw = &event.Raw{Source: "claude.cli", Method: method, Payload: append([]byte(nil), raw...)}
	return []event.Event{e}
}

// resultUsage mirrors the token-count fields on the CLI's terminal `"type":
// "result"` message.
type resultUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// resultFailure is the loose decode of the failure-reporting fields on the
// terminal `"type":"result"` message. Like systemNotice above, every name
// here was read off the 2.1.234 binary's own emitters:
//
//   - the error variants are `{"subtype":"error_during_execution"|
//     "error_max_turns", "is_error":true, "errors":["…"]}` — the message lives
//     in `errors`, NOT in `result`, which those variants omit entirely.
//   - the success variant still carries `is_error` independently, with its
//     message in `result` and an HTTP status in `api_error_status`, so
//     `"subtype":"success"` does not mean the turn succeeded.
//   - `stop_reason:"refusal"` and the `terminal_reason` values
//     ("turn_setup_failed", "budget_exhausted",
//     "structured_output_retry_exhausted", "tool_deferred_unavailable") end a
//     turn with no output while leaving is_error false.
//
// Reading only `is_error` — which is all this parser did — therefore missed
// most of them, and the ones it did catch were flattened to the single word
// "failed" and then dropped downstream (see orchestration's TurnCompleted
// case). Either way the operator saw an empty turn and no reason.
type resultFailure struct {
	Errors         []string `json:"errors"`
	Result         string   `json:"result"`
	StopReason     string   `json:"stop_reason"`
	TerminalReason string   `json:"terminal_reason"`
	APIErrorStatus *int     `json:"api_error_status"`
}

// terminalReasonMessages renders the CLI's terminal_reason codes as sentences.
// A code absent from this map still reports — as itself — rather than being
// swallowed, because the point of this whole path is that an unrecognized
// failure must stay visible.
var terminalReasonMessages = map[string]string{
	"turn_setup_failed":                 "The CLI could not set the turn up and never reached the model.",
	"budget_exhausted":                  "The turn stopped because its token budget was exhausted.",
	"structured_output_retry_exhausted": "The CLI gave up after repeated structured-output failures.",
	"tool_deferred_unavailable":         "The turn stopped because a tool it needed was unavailable.",
}

// resultErrorMessage renders the operator-facing sentence for a failed
// result, or "" when the result reports no failure at all. Returning "" is
// the "this turn was fine" signal — parseResult branches on it rather than
// re-deriving the same conditions.
func resultErrorMessage(w wireLine, f resultFailure) string {
	var detail string
	switch {
	case len(f.Errors) > 0:
		detail = strings.TrimSpace(strings.Join(f.Errors, "; "))
	case w.IsError:
		// Only trusted when is_error is set: on a successful turn `result` is
		// the assistant's final text, which is already in the transcript and
		// must never be re-reported as an error.
		detail = strings.TrimSpace(f.Result)
	}

	var reason string
	switch {
	case f.StopReason == "refusal":
		reason = "The model refused this request, so the turn produced no output."
	case f.TerminalReason != "" && f.TerminalReason != "completed":
		if msg, ok := terminalReasonMessages[f.TerminalReason]; ok {
			reason = msg
		} else {
			reason = "The turn ended early (" + f.TerminalReason + ")."
		}
	case strings.HasPrefix(w.Subtype, "error"):
		reason = "The agent ended the turn with an error."
	case w.IsError:
		reason = "The agent reported an error."
	}

	if reason == "" && detail == "" {
		return ""
	}
	msg := firstNonBlank(reason, "The agent reported an error.")
	if detail != "" && detail != msg {
		msg += " " + detail
	}
	if f.APIErrorStatus != nil {
		msg += fmt.Sprintf(" [HTTP %d]", *f.APIErrorStatus)
	}
	return msg
}

// parseResult handles the CLI's terminal `"type":"result"` message, emitting
// TurnCompleted with usage filled from the reported token counts — preceded
// by a RuntimeError when the result reports a failure, so the reason reaches
// the transcript instead of only the (downstream-ignored) Status field.
//
// Order matters: the error goes FIRST. TurnCompleted is what settles the
// thread back to idle, and a client that stops rendering a turn at that point
// would never show a reason appended after it.
func parseResult(w wireLine, st *parseState, raw []byte) []event.Event {
	// The bytes are already decoded once into wireLine; this second, narrower
	// pass keeps the failure fields out of the hot struct every line pays for.
	var f resultFailure
	_ = json.Unmarshal(raw, &f)
	errMsg := resultErrorMessage(w, f)

	var evts []event.Event
	if errMsg != "" {
		e := st.envelope(event.RuntimeError)
		e.Payload = &event.ErrorPayload{Message: errMsg, Code: firstNonBlank(w.Subtype, f.TerminalReason)}
		e.Raw = &event.Raw{Source: "claude.cli", Method: "result", Payload: append([]byte(nil), raw...)}
		evts = append(evts, e)
	}

	status := "completed"
	if errMsg != "" {
		status = "failed"
	}
	payload := &event.TurnCompletedPayload{Status: status}
	if len(w.Usage) > 0 {
		var u resultUsage
		if err := json.Unmarshal(w.Usage, &u); err == nil {
			payload.Usage = &event.Usage{
				InputTokens:         u.InputTokens,
				OutputTokens:        u.OutputTokens,
				CacheReadTokens:     u.CacheReadInputTokens,
				CacheCreationTokens: u.CacheCreationInputTokens,
			}
		}
	}

	e := st.envelope(event.TurnCompleted)
	e.Payload = payload
	return append(evts, e)
}

// streamEventBody is the nested `"event"` object on `"type":"stream_event"`
// lines — the Anthropic Messages API's own SSE-shaped event, forwarded
// verbatim by the CLI.
type streamEventBody struct {
	Type         string          `json:"type"`
	Index        *int            `json:"index"`
	Message      json.RawMessage `json:"message"`
	ContentBlock json.RawMessage `json:"content_block"`
	Delta        json.RawMessage `json:"delta"`
}

type streamMessage struct {
	ID string `json:"id"`
}

type streamContentBlock struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type streamDelta struct {
	Type        string `json:"type"`
	Text        string `json:"text"`
	Thinking    string `json:"thinking"`
	PartialJSON string `json:"partial_json"`
}

// parseStreamEvent handles `"type":"stream_event"` lines — the delta stream
// that carries text, reasoning, and tool-call construction one token (or
// fragment) at a time.
func parseStreamEvent(w wireLine, st *parseState, raw []byte) []event.Event {
	if len(w.Event) == 0 {
		return warning(st, "stream_event missing event body", raw, "stream_event")
	}
	var body streamEventBody
	if err := json.Unmarshal(w.Event, &body); err != nil {
		return warning(st, "malformed stream_event body: "+err.Error(), raw, "stream_event")
	}

	switch body.Type {
	case "message_start":
		var msg streamMessage
		_ = json.Unmarshal(body.Message, &msg)
		st.currentMessageID = msg.ID
		return nil

	case "content_block_start":
		return st.startContentBlock(body)

	case "content_block_delta":
		return st.deltaContentBlock(body, raw)

	case "content_block_stop":
		return st.stopContentBlock(body)

	default:
		// message_delta, message_stop, and any future stream_event kind:
		// understood, not mapped to a canonical event. Turn completion comes
		// from the CLI's "result" message, not message_stop.
		return nil
	}
}

func (st *parseState) startContentBlock(body streamEventBody) []event.Event {
	if body.Index == nil {
		return nil
	}
	var block streamContentBlock
	_ = json.Unmarshal(body.ContentBlock, &block)
	st.blockKind[*body.Index] = block.Type
	delete(st.blockInput, *body.Index)
	delete(st.blockToolName, *body.Index)

	if block.Type != "tool_use" {
		// Text and reasoning blocks are announced through their deltas as
		// they stream in; only tool calls get an explicit ItemStarted, per
		// the CORE item taxonomy in event/event.go.
		return nil
	}
	st.blockToolName[*body.Index] = block.Name

	if block.Name == "ExitPlanMode" {
		// §1.4: the plan text arrives via parseAssistant/parseControlRequest,
		// never through this block's input_json_delta stream (it streams
		// zero bytes for this tool — verified live, capture m_stdio_plan
		// lines 139-143). Without this skip the transcript shows a disabled,
		// un-expandable "ExitPlanMode" row directly above the plan card that
		// replaces it. blockInput still accumulates below (deltaContentBlock)
		// in case a future CLI starts streaming the plan through the block —
		// that is where it would appear.
		return nil
	}

	itemID := st.itemID(*body.Index)
	e := st.envelope(event.ItemStarted)
	e.ItemID = itemID
	detail, _ := json.Marshal(map[string]string{"toolCallId": block.ID, "name": block.Name})
	e.Payload = &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: block.Name, Detail: detail}
	return []event.Event{e}
}

// deltaContentBlock handles one content_block_delta: text and thinking
// deltas become ContentDelta events on their respective streams; a tool
// call's input_json_delta fragments are accumulated (not emitted) until
// content_block_stop closes the block.
func (st *parseState) deltaContentBlock(body streamEventBody, raw []byte) []event.Event {
	if body.Index == nil {
		return nil
	}
	var delta streamDelta
	if err := json.Unmarshal(body.Delta, &delta); err != nil {
		return warning(st, "malformed content_block_delta: "+err.Error(), raw, "content_block_delta")
	}

	switch delta.Type {
	case "text_delta":
		return []event.Event{st.contentDelta(st.itemID(*body.Index), event.StreamText, delta.Text)}
	case "thinking_delta":
		return []event.Event{st.contentDelta(st.itemID(*body.Index), event.StreamReasoning, delta.Thinking)}
	case "input_json_delta":
		st.blockInput[*body.Index] = append(st.blockInput[*body.Index], delta.PartialJSON...)
		return nil
	default:
		// signature_delta (thinking-block signing) and any future delta
		// kind: understood, nothing to surface as a canonical event yet.
		return nil
	}
}

func (st *parseState) stopContentBlock(body streamEventBody) []event.Event {
	if body.Index == nil {
		return nil
	}
	if st.blockKind[*body.Index] != "tool_use" {
		return nil
	}
	if st.blockToolName[*body.Index] == "ExitPlanMode" {
		// Mirrors the skip in startContentBlock: no ItemStarted means no
		// matching ItemCompleted either, or the client would see a
		// completion for an item it never rendered as started.
		return nil
	}

	itemID := st.itemID(*body.Index)
	e := st.envelope(event.ItemCompleted)
	e.ItemID = itemID
	var detail json.RawMessage
	if accumulated := st.blockInput[*body.Index]; json.Valid(accumulated) {
		detail = accumulated
	}
	e.Payload = &event.ItemCompletedPayload{ItemType: event.ItemToolCall, Status: "completed", Detail: detail}
	return []event.Event{e}
}

func (st *parseState) contentDelta(itemID string, stream event.StreamKind, text string) event.Event {
	e := st.envelope(event.ContentDelta)
	e.ItemID = itemID
	e.Payload = &event.ContentDeltaPayload{
		ItemType: event.ItemAssistantMessage,
		Stream:   stream,
		Text:     text,
		Sequence: st.nextSeq(itemID, stream),
	}
	return e
}
