// Package orchestration is the event-sourced engine. The server never
// mutates state directly: the client sends a Command, the engine turns it
// into a persisted Event, and a projector derives the read model from Events.
//
// t3code equivalents:
//   - contract  -> packages/contracts/src/orchestration.ts
//   - engine    -> apps/server/src/orchestration/Layers/OrchestrationEngine.ts
//   - decider   -> apps/server/src/orchestration/decider.ts
//   - projector -> apps/server/src/orchestration/projector.ts
package orchestration

import (
	"encoding/json"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// NAMING CONVENTION — follow this with discipline, it is what keeps the
// system readable. Command is imperative and dotted; Event is past-tense and
// hyphenated. "thread.turn.start" (command) -> "thread.turn-start-requested"
// (fact). Mix the two once and you will not be able to tell intent from
// occurrence when reading the log.

type CommandType string

const (
	// --- The client may send these ---
	CmdThreadCreate             CommandType = "thread.create"
	CmdThreadTurnStart          CommandType = "thread.turn.start"
	CmdThreadTurnInterrupt      CommandType = "thread.turn.interrupt"
	CmdThreadApprovalRespond    CommandType = "thread.approval.respond"
	CmdThreadUserInputRespond   CommandType = "thread.user-input.respond"
	CmdThreadSessionStop        CommandType = "thread.session.stop"
	CmdThreadRuntimeModeSet     CommandType = "thread.runtime-mode.set"
	CmdThreadInteractionModeSet CommandType = "thread.interaction-mode.set"
	CmdThreadDelete             CommandType = "thread.delete"

	// --- Only the server-side reactor may send these ---
	// This separation matters: if a client could send assistant.delta, it
	// could forge agent output.
	CmdThreadAssistantDelta    CommandType = "thread.message.assistant.delta"
	CmdThreadAssistantComplete CommandType = "thread.message.assistant.complete"
	CmdThreadSessionSet        CommandType = "thread.session.set"
	CmdThreadActivityAppend    CommandType = "thread.activity.append"
	CmdThreadTurnDiffComplete  CommandType = "thread.turn.diff.complete"
	// CmdThreadPlanPropose carries a plan the agent proposed (ExitPlanMode) —
	// server-only for the same reason CmdThreadAssistantDelta is: a client
	// that could dispatch it could forge an agent's plan.
	CmdThreadPlanPropose CommandType = "thread.plan.propose"
)

// ClientDispatchable is the authorization allowlist. Check this at the RPC
// boundary, not inside the decider.
var ClientDispatchable = map[CommandType]bool{
	CmdThreadCreate:             true,
	CmdThreadTurnStart:          true,
	CmdThreadTurnInterrupt:      true,
	CmdThreadApprovalRespond:    true,
	CmdThreadUserInputRespond:   true,
	CmdThreadSessionStop:        true,
	CmdThreadRuntimeModeSet:     true,
	CmdThreadInteractionModeSet: true,
	CmdThreadDelete:             true,
}

// Command is an intent. It has not necessarily happened yet — the decider
// may reject it.
type Command struct {
	// CommandID doubles as a correlation id. The engine uses it for
	// idempotency: a retry with the same CommandID does not produce a second
	// event. This is what saves you when a WebSocket drops and the client
	// resends.
	CommandID string          `json:"commandId"`
	Type      CommandType     `json:"type"`
	ThreadID  string          `json:"threadId,omitempty"`
	IssuedAt  int64           `json:"issuedAt"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// --- Command payloads ---

type TurnStartPayload struct {
	Text        string                  `json:"text"`
	Attachments []provider.Attachment   `json:"attachments,omitempty"`
	Model       provider.ModelSelection `json:"model"`
}

type ApprovalRespondPayload struct {
	RequestID string         `json:"requestId"`
	Decision  event.Decision `json:"decision"`
}

// UserInputRespondPayload answers a question the agent asked (AskUserQuestion).
//
// `Answers` is keyed by the FULL QUESTION TEXT, not by any synthetic id: that
// is the key the claude CLI looks answers up by, verified against captured
// traffic. Re-keying this map reaches the agent as no answer at all.
type UserInputRespondPayload struct {
	RequestID string         `json:"requestId"`
	Answers   map[string]any `json:"answers"`
}

// PlanProposePayload carries the plan the agent proposed via ExitPlanMode.
// Fields mirror event.ProposedPlanPayload field-for-field: Ingestion decodes
// the provider event straight into this shape and dispatches it verbatim.
type PlanProposePayload struct {
	PlanMarkdown string `json:"planMarkdown"`
	// PlanFilePath is the agent-host path the CLI wrote the plan to
	// (~/.claude/plans/<slug>.md on the AGENT's machine, not the user's) —
	// stored as metadata only, never read or linked.
	PlanFilePath string `json:"planFilePath,omitempty"`
	ToolUseID    string `json:"toolUseId,omitempty"`
}

type RuntimeModeSetPayload struct {
	Mode provider.RuntimeMode `json:"mode"`
}

type InteractionModeSetPayload struct {
	Mode provider.InteractionMode `json:"mode"`
}

type AssistantDeltaPayload struct {
	TurnID string `json:"turnId"`
	ItemID string `json:"itemId"`
	// AgentID names the subagent this text came from, empty for the parent
	// conversation — see event.Event.AgentID.
	//
	// It has to be repeated here, unlike on every other forwarded event,
	// because this is the ONE path that does not carry the whole canonical
	// event through to the client: Ingestion re-packs a ContentDelta into
	// this narrow payload (and buffers it), so a field left off here is
	// simply gone, and the subagent's narration would render as the parent
	// talking.
	AgentID  string           `json:"agentId,omitempty"`
	Stream   event.StreamKind `json:"stream"`
	Text     string           `json:"text"`
	Sequence uint64           `json:"sequence"`
}

// ---------------------------------------------------------------------------
// Event (persisted fact)
// ---------------------------------------------------------------------------

type EventType string

const (
	EvtThreadCreated                    EventType = "thread.created"
	EvtThreadTurnStartRequested         EventType = "thread.turn-start-requested"
	EvtThreadTurnInterruptRequested     EventType = "thread.turn-interrupt-requested"
	EvtThreadApprovalResponseRequested  EventType = "thread.approval-response-requested"
	EvtThreadUserInputResponseRequested EventType = "thread.user-input-response-requested"
	EvtThreadSessionStopRequested       EventType = "thread.session-stop-requested"
	EvtThreadRuntimeModeSet             EventType = "thread.runtime-mode-set"
	EvtThreadInteractionModeSet         EventType = "thread.interaction-mode-set"
	EvtThreadSessionSet                 EventType = "thread.session-set"
	EvtThreadMessageSent                EventType = "thread.message-sent"
	EvtThreadActivityAppended           EventType = "thread.activity-appended"
	EvtThreadTurnDiffCompleted          EventType = "thread.turn-diff-completed"
	EvtThreadSettled                    EventType = "thread.settled"
	EvtThreadDeleted                    EventType = "thread.deleted"
	// EvtThreadPlanProposed puts a plan "on the table" (Thread.ProposedPlan).
	// Deliberately NOT in IntentEvents below — it records a fact the agent
	// already reported, it does not trigger a new provider call.
	EvtThreadPlanProposed EventType = "thread.plan-proposed"
)

// IntentEvents are events that trigger provider work. ProviderCommandReactor
// only reacts to this set.
var IntentEvents = map[EventType]bool{
	EvtThreadCreated:                    true,
	EvtThreadTurnStartRequested:         true,
	EvtThreadTurnInterruptRequested:     true,
	EvtThreadApprovalResponseRequested:  true,
	EvtThreadUserInputResponseRequested: true,
	EvtThreadSessionStopRequested:       true,
	EvtThreadRuntimeModeSet:             true,
	EvtThreadInteractionModeSet:         true,
}

// Event is a fact. Once appended, it never changes.
type Event struct {
	// Seq is the global sequence number, assigned by the event store at
	// commit time.
	Seq       uint64          `json:"seq"`
	EventID   string          `json:"eventId"`
	Type      EventType       `json:"type"`
	ThreadID  string          `json:"threadId,omitempty"`
	CommandID string          `json:"commandId"`
	CreatedAt int64           `json:"createdAt"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}
