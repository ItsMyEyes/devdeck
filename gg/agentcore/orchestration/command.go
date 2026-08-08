// Package orchestration adalah engine event-sourced. Server tidak pernah
// memutasi state secara langsung: client mengirim Command, engine mengubahnya
// jadi Event yang dipersist, projeksi menurunkan read model dari Event.
//
// Padanan t3code:
//   - kontrak  -> packages/contracts/src/orchestration.ts
//   - engine   -> apps/server/src/orchestration/Layers/OrchestrationEngine.ts
//   - decider  -> apps/server/src/orchestration/decider.ts
//   - projector-> apps/server/src/orchestration/projector.ts
package orchestration

import (
	"encoding/json"

	"example.com/agentcore/event"
	"example.com/agentcore/provider"
)

// KONVENSI PENAMAAN — ikuti ini dengan disiplin, ini yang bikin sistemnya
// terbaca. Command adalah imperatif bertitik; Event adalah lampau bertanda
// hubung. "thread.turn.start" (perintah) -> "thread.turn-start-requested"
// (fakta). Sekali kamu campur, kamu tidak akan bisa membedakan niat dari
// kejadian saat membaca log.

type CommandType string

const (
	// --- Client boleh mengirim ini ---
	CmdThreadCreate             CommandType = "thread.create"
	CmdThreadTurnStart          CommandType = "thread.turn.start"
	CmdThreadTurnInterrupt      CommandType = "thread.turn.interrupt"
	CmdThreadApprovalRespond    CommandType = "thread.approval.respond"
	CmdThreadUserInputRespond   CommandType = "thread.user-input.respond"
	CmdThreadSessionStop        CommandType = "thread.session.stop"
	CmdThreadRuntimeModeSet     CommandType = "thread.runtime-mode.set"
	CmdThreadInteractionModeSet CommandType = "thread.interaction-mode.set"
	CmdThreadDelete             CommandType = "thread.delete"

	// --- Hanya server-side reactor yang boleh mengirim ini ---
	// Pemisahan ini penting: kalau client bisa mengirim assistant.delta,
	// dia bisa memalsukan output agent.
	CmdThreadAssistantDelta    CommandType = "thread.message.assistant.delta"
	CmdThreadAssistantComplete CommandType = "thread.message.assistant.complete"
	CmdThreadSessionSet        CommandType = "thread.session.set"
	CmdThreadActivityAppend    CommandType = "thread.activity.append"
	CmdThreadTurnDiffComplete  CommandType = "thread.turn.diff.complete"
)

// ClientDispatchable adalah allowlist otorisasi. Cek ini di boundary RPC,
// bukan di dalam decider.
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

// Command adalah niat. Belum tentu terjadi — decider boleh menolaknya.
type Command struct {
	// CommandID merangkap correlation id. Engine memakainya untuk idempotensi:
	// retry dengan CommandID sama tidak menghasilkan event kedua. Ini yang
	// menyelamatkanmu saat WebSocket putus lalu client mengirim ulang.
	CommandID string          `json:"commandId"`
	Type      CommandType     `json:"type"`
	ThreadID  string          `json:"threadId,omitempty"`
	IssuedAt  int64           `json:"issuedAt"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// --- Payload command ---

type TurnStartPayload struct {
	Text        string                  `json:"text"`
	Attachments []provider.Attachment   `json:"attachments,omitempty"`
	Model       provider.ModelSelection `json:"model"`
}

type ApprovalRespondPayload struct {
	RequestID string         `json:"requestId"`
	Decision  event.Decision `json:"decision"`
}

type RuntimeModeSetPayload struct {
	Mode provider.RuntimeMode `json:"mode"`
}

type AssistantDeltaPayload struct {
	TurnID   string           `json:"turnId"`
	ItemID   string           `json:"itemId"`
	Stream   event.StreamKind `json:"stream"`
	Text     string           `json:"text"`
	Sequence uint64           `json:"sequence"`
}

// ---------------------------------------------------------------------------
// Event (fakta yang sudah dipersist)
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
)

// IntentEvents adalah event yang memicu kerja provider. ProviderCommandReactor
// hanya bereaksi pada set ini.
var IntentEvents = map[EventType]bool{
	EvtThreadTurnStartRequested:         true,
	EvtThreadTurnInterruptRequested:     true,
	EvtThreadApprovalResponseRequested:  true,
	EvtThreadUserInputResponseRequested: true,
	EvtThreadSessionStopRequested:       true,
	EvtThreadRuntimeModeSet:             true,
	EvtThreadInteractionModeSet:         true,
}

// Event adalah fakta. Sekali di-append, tidak pernah berubah.
type Event struct {
	// Seq adalah nomor urut global, diberikan event store saat commit.
	Seq       uint64          `json:"seq"`
	EventID   string          `json:"eventId"`
	Type      EventType       `json:"type"`
	ThreadID  string          `json:"threadId,omitempty"`
	CommandID string          `json:"commandId"`
	CreatedAt int64           `json:"createdAt"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}
