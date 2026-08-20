package codex

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// This file maps `codex app-server` JSON-RPC notifications onto DevDeck's
// canonical events. It draws the same distinction claude/parse.go does between
// "ignored on purpose" and "never seen before": a shape this file recognises
// and deliberately does not surface returns no events, while an unknown one
// becomes a RuntimeWarning carrying Raw. A silently dropped message is how a
// provider integration rots without anyone noticing.
//
// The method names below are the CLI's own, taken from
// `codex app-server generate-json-schema`'s ServerNotification variants, not
// from documentation.

// parseState is the per-THREAD bookkeeping a notification needs to become a
// canonical event: which turn is open, and the delta sequence per stream.
//
// Unlike claude/pi this is not per-process — one app-server hosts many
// threads — so the adapter keeps one of these per DevDeck thread and routes
// by the `threadId` every notification carries.
type parseState struct {
	threadID   string // DevDeck's thread id
	codexID    string // the Codex thread id this maps onto
	instanceID provider.InstanceID

	mu     sync.Mutex
	turnID string
	// seq counts deltas per stream so the client can detect a gap. Reset per
	// turn, matching how the other drivers scope it.
	seq map[event.StreamKind]uint64
	// pending tracks server->client REQUESTS this file has opened a real
	// DevDeck approval card for (keyed by the canonical event.RequestID —
	// see rpcIDKey), so RespondToRequest/RespondToUserInput can find the
	// original JSON-RPC id and method to reply on. Mirrors claude/parse.go's
	// pendingRequest map one-for-one.
	pending map[string]pendingRequest
}

// pendingRequest is what a later decision needs to answer a server->client
// REQUEST: the exact JSON-RPC id to echo back (preserving its original
// string-vs-number wire type) and which method it was, since the two
// approval families this file answers share a response shape but not a
// request shape.
type pendingRequest struct {
	rpcID  json.RawMessage
	method string
}

func (st *parseState) setPending(id string, rpcID json.RawMessage, method string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.pending == nil {
		st.pending = map[string]pendingRequest{}
	}
	st.pending[id] = pendingRequest{rpcID: append(json.RawMessage(nil), rpcID...), method: method}
}

func (st *parseState) takePending(id string) (pendingRequest, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	p, ok := st.pending[id]
	if ok {
		delete(st.pending, id)
	}
	return p, ok
}

// rpcIDKey turns a JSON-RPC id (RequestId: string | int64 per the app-server
// schema) into a stable map key / canonical event.RequestID. A JSON string is
// unwrapped so the id doesn't carry stray quote characters into the client;
// a bare number is kept as its literal text.
func rpcIDKey(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

func newParseState(threadID, codexID string, instanceID provider.InstanceID) *parseState {
	return &parseState{
		threadID:   threadID,
		codexID:    codexID,
		instanceID: instanceID,
		seq:        map[event.StreamKind]uint64{},
	}
}

func (st *parseState) setTurnID(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.turnID != id {
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
	e.Raw = &event.Raw{Source: "codex.app-server", Method: method, Payload: append([]byte(nil), raw...)}
	return []event.Event{e}
}

// notification is the loose decode of one JSON-RPC notification line. Only the
// fields this parser acts on are typed; the raw bytes are preserved for the
// warning path so a field this struct does not know about is never lost.
type notification struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// deltaParams covers item/agentMessage/delta and both reasoning delta shapes —
// they differ only in fields this parser does not read (contentIndex).
type deltaParams struct {
	Delta  string `json:"delta"`
	ItemID string `json:"itemId"`
	TurnID string `json:"turnId"`
}

type turnParams struct {
	Turn struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Usage  *struct {
			InputTokens         int64 `json:"inputTokens"`
			CachedInputTokens   int64 `json:"cachedInputTokens"`
			OutputTokens        int64 `json:"outputTokens"`
			ReasoningTokens     int64 `json:"reasoningOutputTokens"`
			TotalTokens         int64 `json:"totalTokens"`
			ContextWindow       int64 `json:"contextWindow"`
			CacheCreationTokens int64 `json:"cacheCreationTokens"`
		} `json:"usage"`
	} `json:"turn"`
}

type itemParams struct {
	Item struct {
		Type    string          `json:"type"`
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
	} `json:"item"`
	TurnID string `json:"turnId"`
}

type errorParams struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// itemTypeOf maps Codex's own item type strings onto the canonical vocabulary.
// Unknown types deliberately become ItemToolCall rather than being dropped:
// the transcript showing an unlabelled step is recoverable, a step vanishing
// is not.
func itemTypeOf(codexType string) event.ItemType {
	switch codexType {
	case "userMessage":
		return event.ItemUserMessage
	case "agentMessage":
		return event.ItemAssistantMessage
	case "reasoning":
		return event.ItemReasoning
	case "commandExecution":
		return event.ItemCommandExec
	case "fileChange":
		return event.ItemFileChange
	case "plan", "todoList":
		return event.ItemPlan
	default:
		return event.ItemToolCall
	}
}

// parseNotification turns one server notification into zero or more canonical
// events.
func parseNotification(line []byte, st *parseState) []event.Event {
	var n notification
	if err := json.Unmarshal(line, &n); err != nil {
		return warning(st, "malformed JSON from codex app-server: "+err.Error(), line, "")
	}

	switch n.Method {

	case "turn/started":
		var p turnParams
		_ = json.Unmarshal(n.Params, &p)
		st.setTurnID(p.Turn.ID)
		e := st.envelope(event.TurnStarted)
		e.Payload = &event.TurnStartedPayload{}
		return []event.Event{e}

	case "item/agentMessage/delta":
		return deltaEvent(st, n.Params, event.StreamText, event.ItemAssistantMessage)

	// Codex splits reasoning into a raw text stream and a summary stream. Both
	// are reasoning as far as the transcript is concerned, so both fold into
	// the one canonical reasoning stream rather than inventing a second kind.
	case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
		return deltaEvent(st, n.Params, event.StreamReasoning, event.ItemReasoning)

	case "item/started":
		var p itemParams
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return warning(st, "malformed item/started: "+err.Error(), line, n.Method)
		}
		if p.TurnID != "" {
			st.setTurnID(p.TurnID)
		}
		// The user's own message comes back on this channel too. It is already
		// in the transcript (the client put it there when it sent the turn), so
		// echoing it would duplicate every message the user typed.
		if p.Item.Type == "userMessage" {
			return nil
		}
		e := st.envelope(event.ItemStarted)
		e.ItemID = p.Item.ID
		e.Payload = &event.ItemStartedPayload{ItemType: itemTypeOf(p.Item.Type)}
		return []event.Event{e}

	case "item/completed":
		var p itemParams
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return warning(st, "malformed item/completed: "+err.Error(), line, n.Method)
		}
		if p.Item.Type == "userMessage" {
			return nil
		}
		e := st.envelope(event.ItemCompleted)
		e.ItemID = p.Item.ID
		e.Payload = &event.ItemCompletedPayload{
			ItemType: itemTypeOf(p.Item.Type),
			Status:   "completed",
			Detail:   p.Item.Content,
		}
		return []event.Event{e}

	case "turn/completed":
		var p turnParams
		_ = json.Unmarshal(n.Params, &p)
		// Turn.status is "completed" | "interrupted" | "failed" (verified via
		// generate-json-schema) and the fixture proves a fatal `error`
		// notification is followed by turn/completed with status "failed" —
		// hardcoding "completed" here silently turned a failed turn into a
		// falsely positive one for every consumer of TurnCompletedPayload.
		status := p.Turn.Status
		if status == "" {
			status = "completed"
		}
		e := st.envelope(event.TurnCompleted)
		payload := &event.TurnCompletedPayload{Status: status}
		if u := p.Turn.Usage; u != nil {
			payload.Usage = &event.Usage{
				InputTokens:         u.InputTokens,
				OutputTokens:        u.OutputTokens,
				CacheReadTokens:     u.CachedInputTokens,
				CacheCreationTokens: u.CacheCreationTokens,
				ContextWindow:       u.ContextWindow,
			}
		}
		e.Payload = payload
		return []event.Event{e}

	case "error":
		var p errorParams
		_ = json.Unmarshal(n.Params, &p)
		msg := p.Error.Message
		if msg == "" {
			msg = "codex reported an error"
		}
		// Deliberately a warning, not SessionExited: the captured `error`
		// notifications include transient ones ("Reconnecting... 1/5",
		// responseStreamDisconnected) that the CLI recovers from on its own.
		// Killing the thread on one would end turns that go on to succeed.
		return warning(st, msg, line, n.Method)

	case "warning", "configWarning", "guardianWarning", "deprecationNotice":
		var p struct {
			Message string `json:"message"`
			Summary string `json:"summary"`
		}
		_ = json.Unmarshal(n.Params, &p)
		msg := p.Message
		if msg == "" {
			msg = p.Summary
		}
		if msg == "" {
			return nil
		}
		return warning(st, msg, line, n.Method)

	case
		// Lifecycle and telemetry this integration knowingly does not surface.
		// Listed rather than defaulted so that a genuinely new method still
		// reaches the warning path below.
		"thread/started", "thread/status/changed", "thread/tokenUsage/updated",
		"thread/name/updated", "thread/closed", "thread/compacted",
		"thread/archived", "thread/unarchived", "thread/deleted",
		"turn/diff/updated", "turn/plan/updated", "turn/moderationMetadata",
		"item/commandExecution/outputDelta", "item/fileChange/outputDelta",
		"item/fileChange/patchUpdated", "item/mcpToolCall/progress",
		"item/plan/delta", "item/reasoning/summaryPartAdded",
		"item/autoApprovalReview/started", "item/autoApprovalReview/completed",
		"item/commandExecution/terminalInteraction",
		"mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed",
		"remoteControl/status/changed", "model/rerouted", "model/verification",
		"model/safetyBuffering/updated", "account/updated",
		"account/rateLimits/updated", "account/login/completed",
		"hook/started", "hook/completed", "skills/changed", "fs/changed",
		"process/exited", "process/outputDelta", "serverRequest/resolved",
		"app/list/updated", "command/exec/outputDelta":
		return nil

	default:
		return warning(st, fmt.Sprintf("unrecognized codex notification %q", n.Method), line, n.Method)
	}
}

// approvalDecisionOptions is offered for both command-execution and
// file-change approvals: CommandExecutionApprovalDecision and
// FileChangeApprovalDecision (app-server 0.145.0, `generate-json-schema`)
// share the exact same four simple-string variants.
var approvalDecisionOptions = []event.Decision{
	event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline, event.DecisionCancel,
}

// parseServerRequest turns one server->client REQUEST (a line carrying both
// `id` and `method` — see the readLoop comment on why these are no longer
// folded into parseNotification) into a canonical event, and records what a
// later RespondToRequest/RespondToUserInput needs to answer it.
//
// Only the two approval families DevDeck's turn/start path actually hits
// under a non-`never` approvalPolicy get a real approval card:
// item/commandExecution/requestApproval and item/fileChange/requestApproval
// (params/response shapes verified live via
// `codex app-server generate-json-schema` against the installed 0.145.0
// binary — see codex-schema capture in this change's PR description).
// Everything else this file doesn't have UI for yet — the EXPERIMENTAL
// item/tool/requestUserInput, permissions/elicitation/dynamic-tool-call/
// token-refresh/attestation, and the two legacy exec/apply-patch methods
// DevDeck never triggers since it only drives turn/start — is reported as
// `needsAutoDecline` so the caller answers immediately with a JSON-RPC
// error. The app-server blocks the turn on every one of these until it gets
// SOME reply; before this function existed none of them ever got one, which
// is the actual mechanism behind a Codex thread hanging on "running"
// forever after DevDeck reported nothing more than an unrecognized-message
// warning.
func parseServerRequest(rpcID json.RawMessage, method string, params json.RawMessage, st *parseState) (evts []event.Event, needsAutoDecline bool) {
	id := rpcIDKey(rpcID)

	switch method {
	case "item/commandExecution/requestApproval":
		var p struct {
			TurnID  string `json:"turnId"`
			Command string `json:"command"`
			Reason  string `json:"reason"`
		}
		_ = json.Unmarshal(params, &p)
		if p.TurnID != "" {
			st.setTurnID(p.TurnID)
		}
		st.setPending(id, rpcID, method)
		detail := p.Command
		if detail == "" {
			detail = "run a command"
		}
		if p.Reason != "" {
			detail += " (" + p.Reason + ")"
		}
		e := st.envelope(event.RequestOpened)
		e.RequestID = id
		e.Payload = &event.RequestOpenedPayload{
			RequestType: event.ReqCommandExecApproval,
			Detail:      detail,
			Args:        params,
			Options:     approvalDecisionOptions,
		}
		return []event.Event{e}, false

	case "item/fileChange/requestApproval":
		var p struct {
			TurnID string `json:"turnId"`
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(params, &p)
		if p.TurnID != "" {
			st.setTurnID(p.TurnID)
		}
		st.setPending(id, rpcID, method)
		detail := p.Reason
		if detail == "" {
			detail = "apply a file change"
		}
		e := st.envelope(event.RequestOpened)
		e.RequestID = id
		e.Payload = &event.RequestOpenedPayload{
			RequestType: event.ReqFileChangeApproval,
			Detail:      detail,
			Args:        params,
			Options:     approvalDecisionOptions,
		}
		return []event.Event{e}, false

	default:
		return warning(st, fmt.Sprintf("codex asked to %q, which DevDeck cannot answer yet; auto-declined", method), params, method), true
	}
}

func deltaEvent(st *parseState, params json.RawMessage, stream event.StreamKind, item event.ItemType) []event.Event {
	var p deltaParams
	if err := json.Unmarshal(params, &p); err != nil {
		return warning(st, "malformed delta: "+err.Error(), params, "delta")
	}
	if p.Delta == "" {
		return nil
	}
	if p.TurnID != "" {
		st.setTurnID(p.TurnID)
	}
	e := st.envelope(event.ContentDelta)
	e.ItemID = p.ItemID
	e.Payload = &event.ContentDeltaPayload{
		ItemType: item,
		Stream:   stream,
		Text:     p.Delta,
		Sequence: st.nextSeq(stream),
	}
	return []event.Event{e}
}
