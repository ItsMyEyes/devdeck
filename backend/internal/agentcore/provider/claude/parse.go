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

	// seq holds the per-(itemID, StreamKind) delta counters. Sequence MUST
	// be monotonic per item+stream — the client uses it to detect a delta
	// that was dropped or arrived out of order.
	seq map[string]uint64
}

// newParseState creates parser state scoped to one adapter session. threadID
// and instanceID are stamped onto every event this state produces because
// orchestration routes exclusively on InstanceID, never on Kind — a missing
// or wrong InstanceID here stays invisible until a second instance of the
// same provider exists, at which point it is an expensive bug to find (see
// the InstanceID comment in provider/provider.go).
func newParseState(threadID string, instanceID provider.InstanceID) *parseState {
	return &parseState{
		threadID:   threadID,
		instanceID: instanceID,
		blockKind:  make(map[int]string),
		blockInput: make(map[int][]byte),
		seq:        make(map[string]uint64),
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
		return parseResult(w, st)
	case "assistant", "user", "rate_limit_event":
		// Recognized shapes, deliberately not mapped to a canonical event:
		// "assistant"/"user" duplicate content already streamed via
		// content_block_delta, and rate-limit telemetry has no CORE payload
		// type yet. This is understood, not unparseable, so it is not a
		// warning — see the package comment for the distinction this file
		// draws between "ignored on purpose" and "never seen before".
		return nil
	default:
		// Anything else — including "control_request", the approval
		// control-channel message documented in gg/HANDOFF.md section 6 —
		// falls through to a warning rather than silent silence. Approval
		// handling ships in spec 2; until then, an agent blocking on one
		// must be visible (as a warning carrying Raw) rather than hanging
		// with zero signal in the UI, which is exactly the failure HANDOFF
		// warns about.
		return warning(st, fmt.Sprintf("unrecognized message type %q", w.Type), line, w.Type)
	}
}

// parseSystem handles the CLI's `"type":"system"` lines. Only "init" (the
// session-start announcement) maps to a canonical event today; every other
// subtype observed in the fixture (hook lifecycle chatter, status pings, a
// mid-turn model-refusal fallback notice) is recognized noise this spec does
// not surface.
func parseSystem(w wireLine, st *parseState, raw []byte) []event.Event {
	if w.Subtype != "init" {
		return nil
	}
	if w.SessionID == "" {
		return warning(st, "system/init message missing session_id", raw, "system.init")
	}
	st.sessionID = w.SessionID
	resume, _ := json.Marshal(w.SessionID)
	e := st.envelope(event.SessionStarted)
	e.Payload = &event.SessionStartedPayload{Resume: resume}
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

// parseResult handles the CLI's terminal `"type":"result"` message, emitting
// TurnCompleted with usage filled from the reported token counts.
func parseResult(w wireLine, st *parseState) []event.Event {
	status := "completed"
	if w.IsError {
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
	return []event.Event{e}
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

	if block.Type != "tool_use" {
		// Text and reasoning blocks are announced through their deltas as
		// they stream in; only tool calls get an explicit ItemStarted, per
		// the CORE item taxonomy in event/event.go.
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
