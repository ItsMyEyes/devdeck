// Package event defines the canonical runtime event — the only language
// used by every layer above the provider.
//
// t3code equivalent: packages/contracts/src/providerRuntime.ts
//
// Ground rule: every adapter MUST translate the provider's native output
// into the types in this package. No provider-specific type may leak into
// orchestration or the client. The only thing allowed to leak is the Raw
// field, and that is purely for debugging/telemetry — there must never be
// logic that reads it.
package event

import (
	"encoding/json"
	"fmt"
	"time"
)

// Type is the canonical event taxonomy. This list is copied from t3code
// because they already hit real cases across 5 different providers; start
// from the subset marked CORE and add the rest only when actually needed.
type Type string

const (
	// --- Session (provider process) --- CORE
	SessionStarted      Type = "session.started"
	SessionConfigured   Type = "session.configured"
	SessionStateChanged Type = "session.state.changed"
	SessionExited       Type = "session.exited"

	// --- Thread (conversation) --- CORE
	ThreadStarted           Type = "thread.started"
	ThreadStateChanged      Type = "thread.state.changed"
	ThreadMetadataUpdated   Type = "thread.metadata.updated"
	ThreadTokenUsageUpdated Type = "thread.token-usage.updated"

	// --- Turn (one user→agent round) --- CORE
	TurnStarted           Type = "turn.started"
	TurnCompleted         Type = "turn.completed"
	TurnAborted           Type = "turn.aborted"
	TurnPlanUpdated       Type = "turn.plan.updated"
	TurnDiffUpdated       Type = "turn.diff.updated"
	TurnProposedCompleted Type = "turn.proposed.completed"

	// --- Item (content unit: message, reasoning, tool call) --- CORE
	ItemStarted   Type = "item.started"
	ItemUpdated   Type = "item.updated"
	ItemCompleted Type = "item.completed"
	ContentDelta  Type = "content.delta"

	// --- Interaction (approval / input) --- CORE
	RequestOpened      Type = "request.opened"
	RequestResolved    Type = "request.resolved"
	UserInputRequested Type = "user-input.requested"
	UserInputResolved  Type = "user-input.resolved"

	// --- Sub-agent / task ---
	TaskStarted   Type = "task.started"
	TaskProgress  Type = "task.progress"
	TaskUpdated   Type = "task.updated"
	TaskCompleted Type = "task.completed"

	// --- Tooling & MCP ---
	ToolProgress     Type = "tool.progress"
	ToolSummary      Type = "tool.summary"
	ToolDenied       Type = "tool.denied"
	MCPStatusUpdated Type = "mcp.status.updated"

	// --- Account & configuration ---
	AuthStatus              Type = "auth.status"
	AccountUpdated          Type = "account.updated"
	AccountRateLimitsUpdate Type = "account.rate-limits.updated"
	ModelRerouted           Type = "model.rerouted"
	ConfigWarning           Type = "config.warning"

	// --- Diagnostics --- CORE
	RuntimeWarning Type = "runtime.warning"
	RuntimeError   Type = "runtime.error"
)

// ItemType is the canonical item kind. Each provider has its own naming
// (Codex "agent_message", Claude "assistant"); all of them map onto this.
type ItemType string

const (
	ItemUserMessage      ItemType = "user_message"
	ItemAssistantMessage ItemType = "assistant_message"
	ItemReasoning        ItemType = "reasoning"
	ItemPlan             ItemType = "plan"
	ItemToolCall         ItemType = "tool_call"
	ItemFileChange       ItemType = "file_change"
	ItemCommandExec      ItemType = "command_execution"
	ItemContextCompact   ItemType = "context_compaction"
	ItemError            ItemType = "error"
	ItemUnknown          ItemType = "unknown"
)

// RequestType is the kind of request that blocks the agent until the user
// answers.
type RequestType string

const (
	ReqCommandExecApproval RequestType = "command_execution_approval"
	ReqFileReadApproval    RequestType = "file_read_approval"
	ReqFileChangeApproval  RequestType = "file_change_approval"
	ReqApplyPatchApproval  RequestType = "apply_patch_approval"
	ReqToolUserInput       RequestType = "tool_user_input"
	ReqUnknown             RequestType = "unknown"
)

// StreamKind distinguishes text streams within a single item. Without this
// you cannot render reasoning separately from the final answer.
type StreamKind string

const (
	StreamText      StreamKind = "text"
	StreamReasoning StreamKind = "reasoning"
	StreamStdout    StreamKind = "stdout"
	StreamStderr    StreamKind = "stderr"
)

// Refs holds the provider's native IDs. Needed for resume, correlation, and
// sending an approval decision back to the provider — but NEVER used as
// identity at the orchestration layer.
type Refs struct {
	SessionID  string `json:"sessionId,omitempty"`
	ThreadID   string `json:"threadId,omitempty"`
	TurnID     string `json:"turnId,omitempty"`
	ItemID     string `json:"itemId,omitempty"`
	CallID     string `json:"callId,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	SubAgentID string `json:"subAgentId,omitempty"`
}

// Raw is for logging/telemetry only. Never write logic that depends on it.
type Raw struct {
	Source  string          `json:"source"`
	Method  string          `json:"method,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Event is the canonical envelope. Payload is typed as an interface so it
// stays type-safe in Go; it unmarshals through the registry below.
type Event struct {
	EventID    string    `json:"eventId"`
	Type       Type      `json:"type"`
	Provider   string    `json:"provider"`
	InstanceID string    `json:"providerInstanceId,omitempty"`
	ThreadID   string    `json:"threadId"`
	TurnID     string    `json:"turnId,omitempty"`
	ItemID     string    `json:"itemId,omitempty"`
	RequestID  string    `json:"requestId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	Refs       *Refs     `json:"providerRefs,omitempty"`
	Raw        *Raw      `json:"raw,omitempty"`
	Payload    Payload   `json:"payload,omitempty"`
}

// Payload is tagged by the Type it matches.
type Payload interface{ EventType() Type }

// ---------------------------------------------------------------------------
// Concrete payloads — CORE ones only; add more as actually needed.
// ---------------------------------------------------------------------------

type SessionStartedPayload struct {
	Message string `json:"message,omitempty"`
	// Resume is an opaque cursor owned by the provider (Claude: sessionId
	// UUID, Codex: threadId). Store it as-is, never interpret it.
	Resume json.RawMessage `json:"resume,omitempty"`
}

func (SessionStartedPayload) EventType() Type { return SessionStarted }

type SessionExitedPayload struct {
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Detail   string `json:"detail,omitempty"`
}

func (SessionExitedPayload) EventType() Type { return SessionExited }

type TurnStartedPayload struct {
	Model string `json:"model,omitempty"`
}

func (TurnStartedPayload) EventType() Type { return TurnStarted }

type TurnCompletedPayload struct {
	Status string `json:"status"` // completed | failed | interrupted
	Usage  *Usage `json:"usage,omitempty"`
}

func (TurnCompletedPayload) EventType() Type { return TurnCompleted }

type Usage struct {
	InputTokens         int64 `json:"inputTokens"`
	OutputTokens        int64 `json:"outputTokens"`
	CacheReadTokens     int64 `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int64 `json:"cacheCreationTokens,omitempty"`
	ContextWindow       int64 `json:"contextWindow,omitempty"`
}

// ProposedPlanPayload carries the plan text the agent proposed via
// ExitPlanMode. Emitted once per proposed plan (deduped by ToolUseID in the
// provider adapter) — see design.md §2/§1.2.
type ProposedPlanPayload struct {
	PlanMarkdown string `json:"planMarkdown"`
	// PlanFilePath is the agent-host path the CLI wrote the plan to
	// (~/.claude/plans/<slug>.md). Metadata only — never read, linked, or
	// opened; that path is not on the user's machine for a remote runtime.
	PlanFilePath string `json:"planFilePath,omitempty"`
	ToolUseID    string `json:"toolUseId,omitempty"`
}

func (ProposedPlanPayload) EventType() Type { return TurnProposedCompleted }

type ItemStartedPayload struct {
	ItemType ItemType        `json:"itemType"`
	Title    string          `json:"title,omitempty"`
	Detail   json.RawMessage `json:"detail,omitempty"`
}

func (ItemStartedPayload) EventType() Type { return ItemStarted }

type ItemCompletedPayload struct {
	ItemType ItemType        `json:"itemType"`
	Status   string          `json:"status,omitempty"`
	Detail   json.RawMessage `json:"detail,omitempty"`
}

func (ItemCompletedPayload) EventType() Type { return ItemCompleted }

type ContentDeltaPayload struct {
	ItemType ItemType   `json:"itemType"`
	Stream   StreamKind `json:"stream"`
	Text     string     `json:"text"`
	// Sequence MUST be monotonic per (ItemID, Stream). The client uses it to
	// detect a delta that was dropped or arrived out of order.
	Sequence uint64 `json:"sequence"`
}

func (ContentDeltaPayload) EventType() Type { return ContentDelta }

// RequestOpenedPayload — the agent is blocking, waiting for the user's
// decision.
type RequestOpenedPayload struct {
	RequestType RequestType     `json:"requestType"`
	Detail      string          `json:"detail,omitempty"`
	Args        json.RawMessage `json:"args,omitempty"`
	// Options are the choices that may be offered to the user for this
	// request. Filled in by the adapter because support varies per provider
	// (e.g. not every provider has an equivalent of "acceptForSession").
	Options []Decision `json:"options,omitempty"`
}

func (RequestOpenedPayload) EventType() Type { return RequestOpened }

type RequestResolvedPayload struct {
	RequestType RequestType `json:"requestType"`
	Decision    Decision    `json:"decision"`
}

func (RequestResolvedPayload) EventType() Type { return RequestResolved }

// Decision — the user's decision on a request.
type Decision string

const (
	DecisionAccept           Decision = "accept"
	DecisionAcceptForSession Decision = "acceptForSession"
	DecisionDecline          Decision = "decline"
	DecisionCancel           Decision = "cancel"
)

func (d Decision) Valid() bool {
	switch d {
	case DecisionAccept, DecisionAcceptForSession, DecisionDecline, DecisionCancel:
		return true
	}
	return false
}

type UserInputRequestedPayload struct {
	Questions json.RawMessage `json:"questions"`
}

func (UserInputRequestedPayload) EventType() Type { return UserInputRequested }

// ToolDeniedPayload — a tool call the CLI asked permission for and the
// system (not the operator — see event.Decision for operator answers)
// answered deny. A1 uses this for ExitPlanMode and every other can_use_tool
// it cannot yet route to a real decision; A2's real approval flow never
// produces this event — a real deny goes through RequestResolved instead.
type ToolDeniedPayload struct {
	ToolName string `json:"toolName"`
	Message  string `json:"message"`
}

func (ToolDeniedPayload) EventType() Type { return ToolDenied }

type ErrorPayload struct {
	Message   string `json:"message"`
	Code      string `json:"code,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

func (ErrorPayload) EventType() Type { return RuntimeError }

type WarningPayload struct {
	Message string `json:"message"`
}

func (WarningPayload) EventType() Type { return RuntimeWarning }

// ---------------------------------------------------------------------------
// Registry for JSON decoding. Required because Payload is an interface.
// ---------------------------------------------------------------------------

var payloadRegistry = map[Type]func() Payload{
	SessionStarted:        func() Payload { return &SessionStartedPayload{} },
	SessionExited:         func() Payload { return &SessionExitedPayload{} },
	TurnStarted:           func() Payload { return &TurnStartedPayload{} },
	TurnCompleted:         func() Payload { return &TurnCompletedPayload{} },
	TurnProposedCompleted: func() Payload { return &ProposedPlanPayload{} },
	ItemStarted:           func() Payload { return &ItemStartedPayload{} },
	ItemCompleted:         func() Payload { return &ItemCompletedPayload{} },
	ContentDelta:          func() Payload { return &ContentDeltaPayload{} },
	RequestOpened:         func() Payload { return &RequestOpenedPayload{} },
	RequestResolved:       func() Payload { return &RequestResolvedPayload{} },
	UserInputRequested:    func() Payload { return &UserInputRequestedPayload{} },
	ToolDenied:            func() Payload { return &ToolDeniedPayload{} },
	RuntimeError:          func() Payload { return &ErrorPayload{} },
	RuntimeWarning:        func() Payload { return &WarningPayload{} },
}

// RegisterPayload adds a new payload type. Call it from your package's
// init().
func RegisterPayload(t Type, mk func() Payload) { payloadRegistry[t] = mk }

func (e *Event) UnmarshalJSON(b []byte) error {
	type alias Event
	var w struct {
		alias
		Payload json.RawMessage `json:"payload,omitempty"`
	}
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*e = Event(w.alias)
	e.Payload = nil
	if len(w.Payload) == 0 || string(w.Payload) == "null" {
		return nil
	}
	mk, ok := payloadRegistry[e.Type]
	if !ok {
		// An unknown event type must not bring down the whole stream. This
		// happens every time a provider ships an update before you've had a
		// chance to add a handler for it.
		return nil
	}
	p := mk()
	if err := json.Unmarshal(w.Payload, p); err != nil {
		return fmt.Errorf("decode payload %s: %w", e.Type, err)
	}
	e.Payload = p
	return nil
}
