package opencode

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// This file maps OpenCode's SSE events onto DevDeck's canonical events —
// split across TWO independent buses, verified live (2026-08-18, a running
// `opencode serve` 1.18.18 driven end to end: session create -> prompt with
// bash's permission set to "ask" -> reply -> the command actually executing):
//
//   - parseEvent handles GET /api/session/{id}/event — one thread's own
//     content stream (session.next.*).
//   - parseGlobalEvent handles GET /api/event — the server-wide bus. A live
//     permission request (`permission.v2.asked`) was captured on THIS stream
//     and NEVER appeared on the per-session one in the same capture — the
//     per-session subscription is structurally incapable of seeing an
//     approval request, not just missing a case for one. See
//     adapter.go's subscribeGlobal.
//
// # The event names here are captured, not copied
//
// t3code's own OpenCode adapter switches on `message.part.delta`,
// `message.part.updated` and friends. Against the binary this package was
// built for (opencode 1.18.18) NONE of those fire — the real stream is
// `session.next.*`. Porting t3code's names would have produced a parser that
// recognised nothing while looking perfectly reasonable. Every name below came
// out of a live capture.
//
// Re-capture before trusting this against a newer CLI; the `next` in the event
// names suggests OpenCode is still moving this surface.
//
// # A known gap
//
// The captured turn was short and carried its whole reply on
// `session.next.text.ended` — no incremental text delta was observed. A delta
// event may well exist for longer replies. This parser therefore emits the
// text it is given and does not depend on deltas arriving; if a delta type
// shows up it will surface as an unknown-event warning, which is the signal to
// come back and map it.
//
// The `session.next.tool.*` family is mapped here as of 2026-08-27 (verified
// against a live `opencode serve` 1.18.18 plus its own /doc OpenAPI); the
// subagent half of it — the `task` tool and the child session it spawns —
// lives in subagent.go.

type parseState struct {
	threadID   string
	sessionID  string
	instanceID provider.InstanceID

	// agentID is the SUBAGENT grouping key stamped onto every event this state
	// produces; empty for a parent conversation. A child session gets its own
	// parseState (see subagent.go's newChildParseState) precisely so this can
	// be a fixed field rather than something each call site has to remember —
	// a payload that forgot to carry it would leak a subagent's row into the
	// main transcript.
	agentID string

	// depth is 0 for the parent conversation and 1 for a subagent of it, so a
	// spawn from this state reports depth+1. opencode refuses to nest past its
	// own `subagent_depth` (default 1), but it counts the parentID chain
	// rather than announcing a depth, so this package has to carry its own.
	depth int

	// pinTurn freezes turnID. Set on a child session's state: its own
	// assistant message ids are not the parent's turn, and letting them
	// through setTurnID would repoint every subsequent parent event at a turn
	// the orchestrator has never heard of.
	pinTurn bool

	mu     sync.Mutex
	turnID string
	seq    map[event.StreamKind]uint64

	// spawns are the `task` tool calls still waiting to be matched to the
	// child session opencode creates for them — see subagent.go.
	spawns []*taskSpawn
}

func newParseState(threadID, sessionID string, instanceID provider.InstanceID) *parseState {
	return &parseState{
		threadID:   threadID,
		sessionID:  sessionID,
		instanceID: instanceID,
		seq:        map[event.StreamKind]uint64{},
	}
}

func (st *parseState) setTurnID(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.pinTurn {
		return
	}
	if id != "" && st.turnID != id {
		st.turnID = id
		st.seq = map[event.StreamKind]uint64{}
	}
}

func (st *parseState) currentTurn() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.turnID
}

func (st *parseState) nextSeq(stream event.StreamKind) uint64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.seq[stream]++
	return st.seq[stream]
}

func (st *parseState) envelope(typ event.Type) event.Event {
	return event.Event{
		Type:       typ,
		Provider:   string(Kind),
		InstanceID: string(st.instanceID),
		ThreadID:   st.threadID,
		TurnID:     st.currentTurn(),
		AgentID:    st.agentID,
		CreatedAt:  time.Now().UTC(),
	}
}

func warning(st *parseState, message string, raw []byte, method string) []event.Event {
	e := st.envelope(event.RuntimeWarning)
	e.Payload = &event.WarningPayload{Message: message}
	e.Raw = &event.Raw{Source: "opencode.sse", Method: method, Payload: append([]byte(nil), raw...)}
	return []event.Event{e}
}

// sseEvent is the envelope every event on the session stream shares.
type sseEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type stepStarted struct {
	AssistantMessageID string `json:"assistantMessageID"`
	Agent              string `json:"agent"`
	Model              struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
}

type textEvent struct {
	AssistantMessageID string `json:"assistantMessageID"`
	TextID             string `json:"textID"`
	Text               string `json:"text"`
}

// stepFailed mirrors SessionNextStepFailed's `data` (verified via the
// running server's own /doc OpenAPI schema, 1.18.18): `error.message` is the
// only field this file surfaces — `error.type` is currently always
// `"unknown"` in the schema, carrying no distinct cases to branch on yet.
type stepFailed struct {
	AssistantMessageID string `json:"assistantMessageID"`
	Error              struct {
		Message string `json:"message"`
	} `json:"error"`
}

type stepEnded struct {
	AssistantMessageID string `json:"assistantMessageID"`
	Finish             string `json:"finish"`
	Tokens             *struct {
		Input     int64 `json:"input"`
		Output    int64 `json:"output"`
		Reasoning int64 `json:"reasoning"`
		Cache     struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
}

// toolEvent is the union of the `data` carried by the session.next.tool.*
// family (field names verified against the running server's own /doc OpenAPI,
// 1.18.18, and against live frames). No single member carries every field —
// `tool`+`input` are on tool.called, `content`+`structured` on
// tool.progress/tool.success, `error` on tool.failed — but `callID` and
// `assistantMessageID` are on all of them, which is all the correlation this
// file needs.
type toolEvent struct {
	AssistantMessageID string          `json:"assistantMessageID"`
	CallID             string          `json:"callID"`
	Tool               string          `json:"tool"`
	Input              json.RawMessage `json:"input"`
	Content            []toolContent   `json:"content"`
	Error              struct {
		Message string `json:"message"`
	} `json:"error"`
}

type toolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// text flattens the tool's textual output. `content` is a LLMToolContent
// union of text and FILE parts; only the text ones have anything a transcript
// can render, and a file part's bytes must never be inlined into an event.
func (t toolEvent) text() string {
	var b strings.Builder
	for _, c := range t.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

// toolDetail is this package's ItemStarted/ItemCompleted Detail shape for a
// tool_call item, deliberately identical to pi's so the client renders an
// OpenCode tool row with the same code path as every other provider's.
type toolDetail struct {
	ToolCallID string          `json:"toolCallId"`
	Name       string          `json:"name,omitempty"`
	Args       json.RawMessage `json:"args,omitempty"`
	Result     string          `json:"result,omitempty"`
	Error      string          `json:"error,omitempty"`
}

// toolCallStarted opens a transcript row for a tool call. Note this fires on
// `tool.called`, not on `tool.input.started`: the input arrives whole and
// already parsed here, whereas the input.* trio streams the raw JSON of the
// arguments a fragment at a time, and rendering half-written JSON as a tool
// row's detail is worse than showing the row a few milliseconds later.
func (st *parseState) toolCallStarted(d toolEvent) []event.Event {
	e := st.envelope(event.ItemStarted)
	e.ItemID = d.CallID
	var args json.RawMessage
	if json.Valid(d.Input) {
		args = d.Input
	}
	detail, _ := json.Marshal(toolDetail{ToolCallID: d.CallID, Name: d.Tool, Args: args})
	e.Payload = &event.ItemStartedPayload{ItemType: event.ItemToolCall, Title: d.Tool, Detail: detail}
	return []event.Event{e}
}

// toolCallEnded closes the row toolCallStarted opened. `tool` is absent from
// the success/failed frames, so the name is not repeated here — the client
// already has it from the ItemStarted sharing this ItemID.
func (st *parseState) toolCallEnded(d toolEvent, status string) []event.Event {
	e := st.envelope(event.ItemCompleted)
	e.ItemID = d.CallID
	detail, _ := json.Marshal(toolDetail{
		ToolCallID: d.CallID,
		Result:     d.text(),
		Error:      d.Error.Message,
	})
	e.Payload = &event.ItemCompletedPayload{ItemType: event.ItemToolCall, Status: status, Detail: detail}
	return []event.Event{e}
}

// parseEvent turns one SSE payload into zero or more canonical events.
func parseEvent(line []byte, st *parseState) []event.Event {
	var ev sseEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return warning(st, "malformed SSE payload from opencode: "+err.Error(), line, "")
	}

	switch ev.Type {

	case "session.next.step.started":
		var d stepStarted
		_ = json.Unmarshal(ev.Data, &d)
		// OpenCode has no turn id of its own; the assistant message id is what
		// every event in the step carries, so it plays that role here.
		st.setTurnID(d.AssistantMessageID)
		e := st.envelope(event.TurnStarted)
		e.Payload = &event.TurnStartedPayload{Model: d.Model.ID}
		return []event.Event{e}

	case "session.next.text.started":
		var d textEvent
		_ = json.Unmarshal(ev.Data, &d)
		st.setTurnID(d.AssistantMessageID)
		e := st.envelope(event.ItemStarted)
		e.ItemID = itemID(d.AssistantMessageID, d.TextID)
		e.Payload = &event.ItemStartedPayload{ItemType: event.ItemAssistantMessage}
		return []event.Event{e}

	case "session.next.text.ended":
		var d textEvent
		_ = json.Unmarshal(ev.Data, &d)
		st.setTurnID(d.AssistantMessageID)
		id := itemID(d.AssistantMessageID, d.TextID)

		out := make([]event.Event, 0, 2)
		if d.Text != "" {
			delta := st.envelope(event.ContentDelta)
			delta.ItemID = id
			delta.Payload = &event.ContentDeltaPayload{
				ItemType: event.ItemAssistantMessage,
				Stream:   event.StreamText,
				Text:     d.Text,
				Sequence: st.nextSeq(event.StreamText),
			}
			out = append(out, delta)
		}
		done := st.envelope(event.ItemCompleted)
		done.ItemID = id
		done.Payload = &event.ItemCompletedPayload{ItemType: event.ItemAssistantMessage, Status: "completed"}
		return append(out, done)

	case "session.next.step.ended":
		var d stepEnded
		_ = json.Unmarshal(ev.Data, &d)
		e := st.envelope(event.TurnCompleted)
		payload := &event.TurnCompletedPayload{Status: "completed"}
		if d.Finish != "" && d.Finish != "stop" {
			payload.Status = d.Finish
		}
		if t := d.Tokens; t != nil {
			payload.Usage = &event.Usage{
				InputTokens:         t.Input,
				OutputTokens:        t.Output + t.Reasoning,
				CacheReadTokens:     t.Cache.Read,
				CacheCreationTokens: t.Cache.Write,
			}
		}
		e.Payload = payload
		return []event.Event{e}

	case "session.next.step.failed":
		// The verified turn-failure signal (live capture, 2026-08-18): a step
		// that errors out sends this instead of session.next.step.ended, and
		// nothing else in this file closes the turn out for it. Before this
		// case existed the failure surfaced only as an unrecognized-event
		// warning and the thread sat on `running` forever — the same shape
		// pi's parser already guards against for a rejected prompt
		// (parseResponse's `w.Command == "prompt"` case): a turn that will
		// never send its normal completion event must be settled here
		// instead, not left for a signal that isn't coming.
		var d stepFailed
		_ = json.Unmarshal(ev.Data, &d)
		msg := d.Error.Message
		if msg == "" {
			msg = "opencode reported a step failure"
		}
		out := warning(st, msg, line, ev.Type)
		completed := st.envelope(event.TurnCompleted)
		completed.Payload = &event.TurnCompletedPayload{Status: "failed"}
		return append(out, completed)

	case "session.next.tool.called":
		var d toolEvent
		_ = json.Unmarshal(ev.Data, &d)
		st.setTurnID(d.AssistantMessageID)
		if d.Tool == taskToolName {
			return st.taskSpawned(d)
		}
		return st.toolCallStarted(d)

	case "session.next.tool.progress":
		var d toolEvent
		_ = json.Unmarshal(ev.Data, &d)
		if sp := st.peekSpawn(d.CallID); sp != nil {
			return st.taskProgressed(sp)
		}
		// A non-task tool's mid-flight output. There is no canonical
		// "item updated" payload to carry it (event.ToolProgress has no
		// registered payload, so the client could not decode one), and the
		// whole output arrives again on tool.success — so this is dropped
		// rather than half-modelled. Same stance as pi's parser takes for a
		// non-subagent tool_execution_update.
		return nil

	case "session.next.tool.success":
		var d toolEvent
		_ = json.Unmarshal(ev.Data, &d)
		st.setTurnID(d.AssistantMessageID)
		out := st.toolCallEnded(d, "completed")
		if sp := st.takeSpawn(d.CallID); sp != nil {
			out = append(out, st.taskFinished(sp, event.TaskStatusCompleted, d.text())...)
		}
		return out

	case "session.next.tool.failed":
		var d toolEvent
		_ = json.Unmarshal(ev.Data, &d)
		st.setTurnID(d.AssistantMessageID)
		out := st.toolCallEnded(d, "failed")
		if sp := st.takeSpawn(d.CallID); sp != nil {
			out = append(out, st.taskFinished(sp, taskStatusFrom(true, d.Error.Message), d.Error.Message)...)
		}
		return out

	case
		// The raw JSON of a tool call's arguments, streamed a fragment at a
		// time before `tool.called` delivers the same arguments whole and
		// parsed. Deliberately ignored — see toolCallStarted.
		"session.next.tool.input.started", "session.next.tool.input.delta",
		"session.next.tool.input.ended",
		// Which PRIMARY agent the session runs as (build/plan/…), switched by
		// POST /api/session/{id}/agent. Despite the name it is NOT a subagent
		// signal — a subagent is a child session (see subagent.go) — and
		// DevDeck has no canonical event for a mode change, so it is noted and
		// dropped rather than surfaced as a transcript row.
		"session.next.agent.switched":
		return nil

	case "session.error":
		// Belt and braces: `session.error` was NOT observed in the live
		// capture's per-session stream (it appears to be a global-bus-only
		// event, alongside permission.v2.asked — see parseGlobalEvent), so
		// this branch is likely unreachable through parseEvent today. Kept
		// rather than removed in case a future OpenCode release routes it
		// here too; costs nothing to also settle the turn if it ever fires.
		out := warning(st, "opencode reported a session error", line, ev.Type)
		completed := st.envelope(event.TurnCompleted)
		completed.Payload = &event.TurnCompletedPayload{Status: "failed"}
		return append(out, completed)

	case
		// The user's own prompt coming back. It is already in the transcript,
		// so echoing it would duplicate every message typed.
		"session.next.prompt.admitted", "session.next.prompted",
		// Bookkeeping with no transcript meaning.
		"session.updated", "session.status", "message.updated", "message.removed":
		return nil

	default:
		return warning(st, fmt.Sprintf("unrecognized opencode event %q", ev.Type), line, ev.Type)
	}
}

// itemID keys a text block within its assistant message. OpenCode numbers
// textIDs per message ("text-0"), so the message id has to be part of the key
// or two messages would collide on their first block.
func itemID(messageID, textID string) string {
	if textID == "" {
		return messageID
	}
	return messageID + "#" + textID
}

// permissionV2Options is offered for every permission.v2.asked request.
// PermissionV2Reply (verified against the running server's own /doc OpenAPI
// schema AND a live round trip — {"reply":"once"} against a real pending
// request actually unblocked the tool call, 2026-08-18) has only three
// values and no "cancel and abort the turn" concept distinct from a plain
// decline, unlike claude/codex — so DevDeck's own DecisionCancel is not
// offered here; opencodeReply (adapter.go) folds it into "reject" if a
// caller sends it anyway.
var permissionV2Options = []event.Decision{
	event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline,
}

// permissionV2AskedData mirrors permission.v2.asked's `data` (verified live,
// 2026-08-18: a real pending bash approval had exactly this shape —
// `{"id":"per_...","sessionID":"ses_...","action":"bash",
// "resources":["echo ..."],"save":[...],"source":{"type":"tool",
// "messageID":"msg_...","callID":"call-..."}}`). `resources[0]` is the
// actual command/path being asked about, not a label — confirmed from the
// same capture.
type permissionV2AskedData struct {
	ID        string   `json:"id"`
	SessionID string   `json:"sessionID"`
	Action    string   `json:"action"`
	Resources []string `json:"resources"`
}

// requestTypeForAction maps OpenCode's permission `action` (the keys of its
// own PermissionConfig: read/edit/glob/grep/list/bash/task/
// external_directory/todowrite/question/webfetch/websearch — from the
// running server's /doc schema) onto DevDeck's canonical RequestType.
// Actions with no canonical equivalent still open a real approval card
// (ReqUnknown), mirroring claude's classifyRequestType default case, rather
// than being silently dropped.
func requestTypeForAction(action string) event.RequestType {
	switch action {
	case "bash":
		return event.ReqCommandExecApproval
	case "edit":
		return event.ReqFileChangeApproval
	case "read":
		return event.ReqFileReadApproval
	default:
		return event.ReqUnknown
	}
}

// parseGlobalEvent turns one frame from the server-wide /api/event bus into
// zero or more canonical events. This is a SEPARATE entry point from
// parseEvent — see the package comment for why: permission.v2.asked/replied
// were verified live to never reach the per-session stream parseEvent reads,
// so folding this into parseEvent's switch would be dead code wearing the
// same clothes as reachable code.
func parseGlobalEvent(line []byte, st *parseState) []event.Event {
	var ev sseEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return warning(st, "malformed global SSE payload from opencode: "+err.Error(), line, "")
	}

	switch ev.Type {
	case "permission.v2.asked":
		var d permissionV2AskedData
		_ = json.Unmarshal(ev.Data, &d)
		if d.ID == "" {
			return warning(st, "permission.v2.asked missing id", line, ev.Type)
		}
		detail := d.Action
		if len(d.Resources) > 0 && d.Resources[0] != "" {
			detail = d.Resources[0]
		}
		e := st.envelope(event.RequestOpened)
		e.RequestID = d.ID
		e.Payload = &event.RequestOpenedPayload{
			RequestType: requestTypeForAction(d.Action),
			Detail:      detail,
			Args:        ev.Data,
			Options:     permissionV2Options,
		}
		return []event.Event{e}

	case "permission.v2.replied":
		// The echo of our own (or a timed-out/interrupted) reply. Nothing to
		// do: RespondToRequest already answered the REST call directly and
		// carries no local pending state to retire (unlike codex, OpenCode's
		// reply endpoint needs only the sessionID + requestID DevDeck already
		// has — see adapter.go's RespondToRequest).
		return nil

	case "session.created":
		// Handled upstream by adapter.go's dispatchGlobalEvent, which is the
		// only layer that can act on it: `info.parentID` names a SUBAGENT's
		// child session, and registering that link needs the adapter's session
		// map, not a parser. Silent here so the parent's own creation frame —
		// which every session produces — does not warn.
		return nil

	default:
		// server.connected/server.heartbeat and any global-bus event this
		// file has not mapped yet — silence for the known-benign ones, a
		// warning otherwise so a new global event type doesn't rot unseen.
		if ev.Type == "server.connected" || ev.Type == "server.heartbeat" {
			return nil
		}
		// The global bus is a superset of the per-session one: every
		// `session.next.*` frame appears on BOTH (verified live, 2026-08-27).
		// parseEvent already handles them off the per-session subscription, so
		// re-parsing here would double every transcript row — and before this
		// case existed the default below turned each one into a second,
		// duplicate "unrecognized" warning, which is what made an OpenCode
		// turn look like a wall of parser errors. A CHILD session's frames are
		// the exception and never reach this function; dispatchGlobalEvent
		// re-homes them through parseChildEvent instead.
		if strings.HasPrefix(ev.Type, "session.next.") {
			return nil
		}
		return warning(st, fmt.Sprintf("unrecognized opencode global event %q", ev.Type), line, ev.Type)
	}
}
