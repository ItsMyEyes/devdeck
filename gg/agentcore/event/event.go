// Package event mendefinisikan canonical runtime event — satu-satunya bahasa
// yang dipakai lapisan di atas provider.
//
// Padanan t3code: packages/contracts/src/providerRuntime.ts
//
// Aturan main: setiap adapter WAJIB menerjemahkan output native provider ke
// tipe di package ini. Tidak ada tipe khusus provider yang boleh bocor ke
// orchestration atau client. Yang boleh bocor cuma field Raw, dan itu murni
// untuk debugging/telemetry — jangan pernah ada logic yang membacanya.
package event

import (
	"encoding/json"
	"fmt"
	"time"
)

// Type adalah taksonomi event kanonik. Daftar ini disalin dari t3code karena
// mereka sudah menabrak kasus nyata dari 5 provider berbeda; mulailah dari
// subset (ditandai CORE) dan tambahkan sisanya saat benar-benar dibutuhkan.
type Type string

const (
	// --- Sesi (proses provider) --- CORE
	SessionStarted      Type = "session.started"
	SessionConfigured   Type = "session.configured"
	SessionStateChanged Type = "session.state.changed"
	SessionExited       Type = "session.exited"

	// --- Thread (percakapan) --- CORE
	ThreadStarted           Type = "thread.started"
	ThreadStateChanged      Type = "thread.state.changed"
	ThreadMetadataUpdated   Type = "thread.metadata.updated"
	ThreadTokenUsageUpdated Type = "thread.token-usage.updated"

	// --- Turn (satu giliran user→agent) --- CORE
	TurnStarted     Type = "turn.started"
	TurnCompleted   Type = "turn.completed"
	TurnAborted     Type = "turn.aborted"
	TurnPlanUpdated Type = "turn.plan.updated"
	TurnDiffUpdated Type = "turn.diff.updated"

	// --- Item (unit isi: pesan, reasoning, tool call) --- CORE
	ItemStarted   Type = "item.started"
	ItemUpdated   Type = "item.updated"
	ItemCompleted Type = "item.completed"
	ContentDelta  Type = "content.delta"

	// --- Interaksi (approval / input) --- CORE
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

	// --- Akun & konfigurasi ---
	AuthStatus              Type = "auth.status"
	AccountUpdated          Type = "account.updated"
	AccountRateLimitsUpdate Type = "account.rate-limits.updated"
	ModelRerouted           Type = "model.rerouted"
	ConfigWarning           Type = "config.warning"

	// --- Diagnostik --- CORE
	RuntimeWarning Type = "runtime.warning"
	RuntimeError   Type = "runtime.error"
)

// ItemType — jenis item kanonik. Provider punya nama sendiri-sendiri
// (Codex "agent_message", Claude "assistant"), semua dipetakan ke sini.
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

// RequestType — jenis permintaan yang memblokir agent sampai user menjawab.
type RequestType string

const (
	ReqCommandExecApproval RequestType = "command_execution_approval"
	ReqFileReadApproval    RequestType = "file_read_approval"
	ReqFileChangeApproval  RequestType = "file_change_approval"
	ReqApplyPatchApproval  RequestType = "apply_patch_approval"
	ReqToolUserInput       RequestType = "tool_user_input"
	ReqUnknown             RequestType = "unknown"
)

// StreamKind membedakan aliran teks dalam satu item. Tanpa ini kamu tidak bisa
// merender reasoning terpisah dari jawaban akhir.
type StreamKind string

const (
	StreamText      StreamKind = "text"
	StreamReasoning StreamKind = "reasoning"
	StreamStdout    StreamKind = "stdout"
	StreamStderr    StreamKind = "stderr"
)

// Refs menyimpan ID native provider. Dibutuhkan untuk resume, korelasi, dan
// mengirim balik keputusan approval ke provider — TAPI tidak pernah dipakai
// sebagai identitas di lapisan orchestration.
type Refs struct {
	SessionID  string `json:"sessionId,omitempty"`
	ThreadID   string `json:"threadId,omitempty"`
	TurnID     string `json:"turnId,omitempty"`
	ItemID     string `json:"itemId,omitempty"`
	CallID     string `json:"callId,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	SubAgentID string `json:"subAgentId,omitempty"`
}

// Raw hanya untuk log/telemetry. Jangan bikin logic yang bergantung padanya.
type Raw struct {
	Source  string          `json:"source"`
	Method  string          `json:"method,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Event adalah amplop kanonik. Payload bertipe interface supaya tetap
// type-safe di Go; unmarshal-nya lewat registry di bawah.
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

// Payload ditandai oleh Type yang cocok dengannya.
type Payload interface{ EventType() Type }

// ---------------------------------------------------------------------------
// Payload konkret — cukup yang CORE; tambahkan sesuai kebutuhan.
// ---------------------------------------------------------------------------

type SessionStartedPayload struct {
	Message string `json:"message,omitempty"`
	// Resume adalah cursor buram milik provider (Claude: sessionId UUID,
	// Codex: threadId). Simpan apa adanya, jangan ditafsirkan.
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
	// Sequence wajib monoton per (ItemID, Stream). Client memakainya untuk
	// mendeteksi delta yang hilang atau datang terbalik.
	Sequence uint64 `json:"sequence"`
}

func (ContentDeltaPayload) EventType() Type { return ContentDelta }

// RequestOpenedPayload — agent memblokir, menunggu keputusan user.
type RequestOpenedPayload struct {
	RequestType RequestType     `json:"requestType"`
	Detail      string          `json:"detail,omitempty"`
	Args        json.RawMessage `json:"args,omitempty"`
	// Options adalah pilihan yang boleh ditawarkan ke user untuk request ini.
	// Diisi adapter karena tiap provider beda dukungannya (mis. tidak semua
	// punya padanan "acceptForSession").
	Options []Decision `json:"options,omitempty"`
}

func (RequestOpenedPayload) EventType() Type { return RequestOpened }

type RequestResolvedPayload struct {
	RequestType RequestType `json:"requestType"`
	Decision    Decision    `json:"decision"`
}

func (RequestResolvedPayload) EventType() Type { return RequestResolved }

// Decision — keputusan user atas sebuah request.
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
// Registry untuk decode JSON. Wajib ada karena Payload adalah interface.
// ---------------------------------------------------------------------------

var payloadRegistry = map[Type]func() Payload{
	SessionStarted:     func() Payload { return &SessionStartedPayload{} },
	SessionExited:      func() Payload { return &SessionExitedPayload{} },
	TurnStarted:        func() Payload { return &TurnStartedPayload{} },
	TurnCompleted:      func() Payload { return &TurnCompletedPayload{} },
	ItemStarted:        func() Payload { return &ItemStartedPayload{} },
	ItemCompleted:      func() Payload { return &ItemCompletedPayload{} },
	ContentDelta:       func() Payload { return &ContentDeltaPayload{} },
	RequestOpened:      func() Payload { return &RequestOpenedPayload{} },
	RequestResolved:    func() Payload { return &RequestResolvedPayload{} },
	UserInputRequested: func() Payload { return &UserInputRequestedPayload{} },
	RuntimeError:       func() Payload { return &ErrorPayload{} },
	RuntimeWarning:     func() Payload { return &WarningPayload{} },
}

// RegisterPayload menambah tipe payload baru. Panggil dari init() paket kamu.
func RegisterPayload(t Type, mk func() Payload) { payloadRegistry[t] = mk }

type wireEvent struct {
	Event
	Payload json.RawMessage `json:"payload,omitempty"`
}

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
		// Event tipe tak dikenal tidak boleh menjatuhkan seluruh stream.
		// Ini terjadi tiap kali provider di-update sebelum kamu sempat
		// menambah handler-nya.
		return nil
	}
	p := mk()
	if err := json.Unmarshal(w.Payload, p); err != nil {
		return fmt.Errorf("decode payload %s: %w", e.Type, err)
	}
	e.Payload = p
	return nil
}

var _ = wireEvent{}
