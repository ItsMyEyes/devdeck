package opencode

import (
	"encoding/json"
	"fmt"
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
// come back and map it. The same live capture that found permission.v2.asked
// also surfaced `session.next.tool.called` / `tool.input.started` /
// `tool.input.ended` / `tool.success` on a turn that actually ran a shell
// command — none of which this file maps yet, so every OpenCode tool call
// currently renders as an unknown-event warning rather than a transcript tool
// row. Out of scope for the permission-hang fix; tracked as a known gap, not
// fixed here.

type parseState struct {
	threadID   string
	sessionID  string
	instanceID provider.InstanceID

	mu     sync.Mutex
	turnID string
	seq    map[event.StreamKind]uint64
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

	default:
		// server.connected/server.heartbeat and any global-bus event this
		// file has not mapped yet — silence for the two known-benign ones,
		// a warning otherwise so a new global event type doesn't rot unseen.
		if ev.Type == "server.connected" || ev.Type == "server.heartbeat" {
			return nil
		}
		return warning(st, fmt.Sprintf("unrecognized opencode global event %q", ev.Type), line, ev.Type)
	}
}
