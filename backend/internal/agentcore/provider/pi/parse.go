// Package pi turns Pi's `--mode rpc` JSON Lines transport into canonical
// runtime events.
//
// This mapping was built from a live-captured session (pi v0.78.1, provider
// ollama) rather than pi.dev's published docs alone — the docs describe the
// event vocabulary loosely ("message_update: streaming deltas") and get
// several concrete names wrong (no "reasoning_delta"; it is "thinking_delta").
// testdata/turn.jsonl is that captured session, trimmed to one get_state
// response plus one full tool-using turn. Whenever this file is revisited
// against a newer CLI, recapture the fixture live and diff — never patch
// this mapping from doc text alone.
//
// Key shape not obvious from the docs: `turn_start`/`turn_end` fire once per
// model round-trip, and a single user prompt can cause several round-trips
// when a tool call is involved (round 1: decide to call the tool; round 2:
// answer using the result). `agent_start`/`agent_end` bracket the whole
// exchange for one prompt instead, so agent_end — not turn_end — is what
// maps to this package's TurnCompleted.
//
// Every message shape this file does not recognize becomes a single
// event.RuntimeWarning carrying the original bytes in Raw, never a crash and
// never a silent drop — see claude/parse.go's package comment for why that
// degrade-not-crash contract matters for an unversioned wire format.
package pi

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// initRequestID tags the one get_state request the adapter sends itself,
// right after spawning a session, purely to learn the native session id —
// pi's RPC mode does not announce one unprompted the way claude's CLI
// announces "system"/"init" on startup. parseLine recognizes the response by
// this id and treats it as the session-started signal.
const initRequestID = "__devdeck_init__"

// parseState carries everything parseLine needs across the JSON lines of one
// adapter session.
type parseState struct {
	threadID   string
	instanceID provider.InstanceID

	// turnID is stamped onto every event emitted while a turn is in flight.
	// Set by the adapter via setTurnID before it writes a prompt to stdin.
	turnID string

	// sessionID is Pi's native session UUID, learned from the init
	// get_state response. Lives in Refs only, never used as orchestration
	// identity.
	sessionID string

	// messageSeq counts assistant message_start events seen this session.
	// Pi's message objects carry no id of their own (unlike claude's
	// message.id), so contentIndex alone is not a stable item key across
	// message rounds — a tool-call round and the following text round both
	// start their content array back at index 0. messageSeq disambiguates.
	messageSeq int

	// seq holds the per-(itemID, StreamKind) delta counters. Must be
	// monotonic per item+stream — the client uses it to detect a dropped or
	// reordered delta.
	seq map[string]uint64
}

func newParseState(threadID string, instanceID provider.InstanceID) *parseState {
	return &parseState{
		threadID:   threadID,
		instanceID: instanceID,
		seq:        make(map[string]uint64),
	}
}

func (st *parseState) setTurnID(id string) { st.turnID = id }

func (st *parseState) nextSeq(itemID string, stream event.StreamKind) uint64 {
	key := itemID + "|" + string(stream)
	st.seq[key]++
	return st.seq[key]
}

// textItemID keys a text/thinking content block by (message round, content
// index) — see messageSeq's doc comment for why contentIndex alone is not
// enough. Tool-call items use their own toolCallId instead (see
// toolExecutionStarted) since that is already a stable, unique key.
func (st *parseState) textItemID(contentIndex int) string {
	return strconv.Itoa(st.messageSeq) + "#" + strconv.Itoa(contentIndex)
}

func (st *parseState) refs() *event.Refs {
	if st.sessionID == "" {
		return nil
	}
	return &event.Refs{SessionID: st.sessionID}
}

func (st *parseState) envelope(typ event.Type) event.Event {
	return event.Event{
		Type:       typ,
		Provider:   string(Kind),
		InstanceID: string(st.instanceID),
		ThreadID:   st.threadID,
		TurnID:     st.turnID,
		CreatedAt:  time.Now().UTC(),
		Refs:       st.refs(),
	}
}

func warning(st *parseState, message string, raw []byte, method string) []event.Event {
	e := st.envelope(event.RuntimeWarning)
	e.Payload = &event.WarningPayload{Message: message}
	e.Raw = &event.Raw{Source: "pi.cli", Method: method, Payload: append([]byte(nil), raw...)}
	return []event.Event{e}
}

// wireLine is a loose decode of one JSON line. Only fields this parser acts
// on are typed; every byte of the line survives untouched in Raw for the
// warning path.
type wireLine struct {
	Type                   string          `json:"type"`
	ID                     string          `json:"id"`
	Command                string          `json:"command"`
	Success                *bool           `json:"success"`
	Error                  string          `json:"error"`
	Data                   json.RawMessage `json:"data"`
	Message                json.RawMessage `json:"message"`
	AssistantMessageEvent  json.RawMessage `json:"assistantMessageEvent"`
	ToolCallID             string          `json:"toolCallId"`
	ToolName               string          `json:"toolName"`
	Args                   json.RawMessage `json:"args"`
	Result                 json.RawMessage `json:"result"`
	IsError                bool            `json:"isError"`
}

// parseLine turns one JSON line into zero or more canonical events. It never
// panics and never returns an error — a line this parser cannot make sense
// of becomes a runtime.warning event instead of taking the session down.
func parseLine(line []byte, st *parseState) []event.Event {
	var w wireLine
	if err := json.Unmarshal(line, &w); err != nil {
		return warning(st, "malformed JSON from pi CLI: "+err.Error(), line, "")
	}

	switch w.Type {
	case "response":
		return parseResponse(w, st, line)
	case "agent_end":
		return parseAgentEnd(w, st, line)
	case "message_start":
		return st.messageStarted(w)
	case "message_update":
		return parseMessageUpdate(w, st, line)
	case "tool_execution_start":
		return st.toolExecutionStarted(w, line)
	case "tool_execution_end":
		return st.toolExecutionCompleted(w, line)
	case "extension_ui_request":
		return parseExtensionUIRequest(w, st, line)
	case "extension_error":
		return parseExtensionError(w, st, line)
	case "message_end", "agent_start", "turn_start", "turn_end",
		"tool_execution_update", "queue_update", "compaction_start",
		"compaction_end", "auto_retry_start", "auto_retry_end",
		"bash_execution_update":
		// Recognized, deliberately not mapped:
		//  - message_end duplicates what message_update already streamed.
		//  - agent_start/turn_start/turn_end: the adapter emits its own
		//    TurnStarted synchronously in SendTurn (matching claude); the
		//    round-trip-scoped turn_end is not this package's turn boundary
		//    (see package comment) and agent_end covers turn completion.
		//  - tool_execution_update: no ItemUpdated payload type exists yet
		//    in event.go; start/end alone bracket the call.
		//  - queue_update: steering/follow-up queues are not modeled yet.
		//  - compaction_*/auto_retry_*: internal detail, no CORE event yet.
		//  - bash_execution_update: only fires for the `bash` RPC command,
		//    which this adapter never sends.
		return nil
	default:
		return warning(st, fmt.Sprintf("unrecognized message type %q", w.Type), line, w.Type)
	}
}

// parseResponse handles command acknowledgements. Most are fire-and-forget
// from the adapter's side and produce no event; three cases need one:
//   - the adapter's own init get_state, which is how this package learns the
//     session id (pi's RPC mode has no unprompted startup announcement);
//   - a rejected prompt, which must complete the turn as failed or the UI
//     hangs on "Working..." forever, since no agent_end will ever arrive for
//     a prompt pi never started;
//   - any other failed command, surfaced as a warning.
func parseResponse(w wireLine, st *parseState, raw []byte) []event.Event {
	if w.ID == initRequestID && w.Command == "get_state" {
		var data struct {
			SessionID string `json:"sessionId"`
		}
		if len(w.Data) > 0 {
			_ = json.Unmarshal(w.Data, &data)
		}
		if data.SessionID == "" {
			return warning(st, "get_state response missing sessionId", raw, "response.get_state")
		}
		st.sessionID = data.SessionID
		resume, _ := json.Marshal(data.SessionID)
		e := st.envelope(event.SessionStarted)
		e.Payload = &event.SessionStartedPayload{Resume: resume}
		return []event.Event{e}
	}

	if w.Success == nil || *w.Success {
		return nil
	}

	if w.Command == "prompt" {
		e := st.envelope(event.TurnCompleted)
		e.Payload = &event.TurnCompletedPayload{Status: "failed"}
		return []event.Event{e}
	}

	detail := w.Error
	if detail == "" {
		detail = "no error detail"
	}
	return warning(st, fmt.Sprintf("pi command %q failed: %s", w.Command, detail), raw, "response."+w.Command)
}

// piMessageUsage mirrors the token-count fields on each message in
// agent_end's `messages` array.
type piMessageUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

type piAgentEndBody struct {
	Messages []struct {
		Role  string          `json:"role"`
		Usage *piMessageUsage `json:"usage"`
	} `json:"messages"`
}

// parseAgentEnd handles the exchange's terminal event — see the package
// comment for why this, not turn_end, is this package's TurnCompleted.
// Usage is a best-effort sum across every assistant message in the
// exchange, since agent_end carries no single aggregate total of its own.
func parseAgentEnd(w wireLine, st *parseState, raw []byte) []event.Event {
	var body piAgentEndBody
	_ = json.Unmarshal(raw, &body)

	var usage *event.Usage
	for _, m := range body.Messages {
		if m.Role != "assistant" || m.Usage == nil {
			continue
		}
		if usage == nil {
			usage = &event.Usage{}
		}
		usage.InputTokens += m.Usage.Input
		usage.OutputTokens += m.Usage.Output
		usage.CacheReadTokens += m.Usage.CacheRead
		usage.CacheCreationTokens += m.Usage.CacheWrite
	}

	e := st.envelope(event.TurnCompleted)
	e.Payload = &event.TurnCompletedPayload{Status: "completed", Usage: usage}
	return []event.Event{e}
}

// messageStarted tracks assistant message rounds for textItemID. It never
// itself emits a canonical event — text/thinking blocks are announced by
// their own deltas as they stream, matching claude's parser.
func (st *parseState) messageStarted(w wireLine) []event.Event {
	var m struct {
		Role string `json:"role"`
	}
	if len(w.Message) > 0 {
		_ = json.Unmarshal(w.Message, &m)
	}
	if m.Role == "assistant" {
		st.messageSeq++
	}
	return nil
}

// parseMessageUpdate handles the delta stream that carries text and
// reasoning one fragment at a time. Tool-call construction
// (toolcall_start/delta/end) is deliberately not surfaced here — the
// tool_execution_start/end pair below reports the call once it actually
// runs, with a cleaner, flatter shape than the nested partial-content-array
// toolcall_* events carry.
func parseMessageUpdate(w wireLine, st *parseState, raw []byte) []event.Event {
	if len(w.AssistantMessageEvent) == 0 {
		return warning(st, "message_update missing assistantMessageEvent", raw, "message_update")
	}
	var ev struct {
		Type         string `json:"type"`
		ContentIndex *int   `json:"contentIndex"`
		Delta        string `json:"delta"`
	}
	if err := json.Unmarshal(w.AssistantMessageEvent, &ev); err != nil {
		return warning(st, "malformed assistantMessageEvent: "+err.Error(), raw, "message_update")
	}
	if ev.ContentIndex == nil {
		return nil
	}

	switch ev.Type {
	case "text_delta":
		return []event.Event{st.contentDelta(st.textItemID(*ev.ContentIndex), event.StreamText, ev.Delta)}
	case "thinking_delta":
		return []event.Event{st.contentDelta(st.textItemID(*ev.ContentIndex), event.StreamReasoning, ev.Delta)}
	default:
		// text_start/text_end/thinking_start/thinking_end/toolcall_start/
		// toolcall_delta/toolcall_end: understood, nothing to surface here.
		return nil
	}
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

// toolDetail is this package's ItemStarted/ItemCompleted Detail shape for a
// tool_call item — deliberately provider-flavored (Raw's contract applies
// only to the warning path; Detail is meant to be read).
type toolDetail struct {
	ToolCallID string          `json:"toolCallId"`
	Name       string          `json:"name,omitempty"`
	Args       json.RawMessage `json:"args,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
}

func (st *parseState) toolExecutionStarted(w wireLine, raw []byte) []event.Event {
	if w.ToolCallID == "" {
		return warning(st, "tool_execution_start missing toolCallId", raw, "tool_execution_start")
	}
	e := st.envelope(event.ItemStarted)
	e.ItemID = w.ToolCallID
	detail, _ := json.Marshal(toolDetail{ToolCallID: w.ToolCallID, Name: w.ToolName, Args: w.Args})
	e.Payload = &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: w.ToolName, Detail: detail}
	return []event.Event{e}
}

func (st *parseState) toolExecutionCompleted(w wireLine, raw []byte) []event.Event {
	if w.ToolCallID == "" {
		return warning(st, "tool_execution_end missing toolCallId", raw, "tool_execution_end")
	}
	status := "completed"
	if w.IsError {
		status = "failed"
	}
	e := st.envelope(event.ItemCompleted)
	e.ItemID = w.ToolCallID
	detail, _ := json.Marshal(toolDetail{ToolCallID: w.ToolCallID, Name: w.ToolName, Result: w.Result})
	e.Payload = &event.ItemCompletedPayload{ItemType: event.ItemToolCall, Status: status, Detail: detail}
	return []event.Event{e}
}

// parseExtensionUIRequest surfaces an approval/input dialog raised by an
// extension. RequestType is ReqUnknown — Pi's dialogs (arbitrary select/
// confirm prompts) don't map onto this package's fixed approval taxonomy —
// and Options is left empty rather than guessed. RespondToRequest is a
// no-op (see adapter.go), so this exists purely to make a blocked agent
// visible instead of silently hanging, matching claude's spec-1 precedent
// for its own unhandled control_request.
func parseExtensionUIRequest(w wireLine, st *parseState, raw []byte) []event.Event {
	var body struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Title  string `json:"title"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return warning(st, "malformed extension_ui_request: "+err.Error(), raw, "extension_ui_request")
	}
	detail := body.Title
	if detail == "" {
		detail = body.Method
	}
	e := st.envelope(event.RequestOpened)
	e.RequestID = body.ID
	e.Payload = &event.RequestOpenedPayload{RequestType: event.ReqUnknown, Detail: detail}
	return []event.Event{e}
}

func parseExtensionError(w wireLine, st *parseState, raw []byte) []event.Event {
	var body struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	msg := body.Message
	if msg == "" {
		msg = body.Error
	}
	if msg == "" {
		msg = "pi extension error"
	}
	return warning(st, msg, raw, "extension_error")
}
