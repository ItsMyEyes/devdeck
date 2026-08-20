// Package provider holds two core abstractions: Driver (config + factory)
// and Adapter (a live runtime). This split is what keeps the orchestration
// layer from ever needing to know which agent is behind a given thread.
//
// t3code equivalents:
//   - Driver  -> apps/server/src/provider/ProviderDriver.ts
//   - Adapter -> apps/server/src/provider/Services/ProviderAdapter.ts
//   - Registry-> apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"devdeck/backend/internal/agentcore/event"
)

// Kind is the identity of a driver type: "claude", "codex", "cursor", ...
type Kind string

// InstanceID is the identity of one configured instance.
// IMPORTANT: this is not Kind. A single user can have two "claude" instances
// with different accounts/HOME dirs. t3code paid for a painful migration
// because it originally routed on Kind — start with InstanceID from day one.
type InstanceID string

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// Driver is a declarative value, not a process. It knows how to read config
// and how to build an Adapter; it holds no runtime state of its own.
type Driver interface {
	Kind() Kind

	// DefaultConfig returns an empty but valid config.
	DefaultConfig() json.RawMessage

	// DecodeConfig validates an instance's raw config.
	// Return a clear error — this is what the user sees in the settings UI.
	DecodeConfig(raw json.RawMessage) (Config, error)

	// Probe checks whether this provider is usable: does the binary exist?
	// which version? is it logged in? which models are available?
	// Called periodically, so it must be cheap and must not touch a live
	// session.
	Probe(ctx context.Context, cfg Config) (Snapshot, error)

	// Create builds a live Adapter. The given ctx binds the adapter's
	// lifetime: when ctx is cancelled, every child process must die too.
	Create(ctx context.Context, spec InstanceSpec) (Adapter, error)
}

// Config is an already-validated config. Every driver has its own concrete
// type; this interface is just a marker.
type Config interface{ ProviderKind() Kind }

type InstanceSpec struct {
	InstanceID  InstanceID
	DisplayName string
	Config      Config
	Env         map[string]string
	Enabled     bool
}

// Snapshot is the provider status shown in the UI.
type Snapshot struct {
	InstanceID   InstanceID
	Kind         Kind
	Available    bool
	Version      string
	BinaryPath   string
	Authed       bool
	AccountLabel string
	Models       []Model
	Detail       string // reason, when Available == false
}

type Model struct {
	Slug         string
	Name         string
	Capabilities map[string]any // effort, thinking, etc — shape is per-provider
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

// SessionModelSwitch declares whether the model can be changed mid-session.
// Claude can; some providers must restart the session. Orchestration needs
// to know this to decide whether to restart or not.
type SessionModelSwitch string

const (
	ModelSwitchInSession   SessionModelSwitch = "in-session"
	ModelSwitchUnsupported SessionModelSwitch = "unsupported"
)

type Capabilities struct {
	SessionModelSwitch SessionModelSwitch
	SupportsPlanMode   bool
	SupportsResume     bool
	SupportsMCP        bool
}

// RuntimeMode maps a uniform permission policy onto each provider's
// equivalent. t3code: approval-required | auto-accept-edits | auto |
// full-access.
type RuntimeMode string

const (
	ModeApprovalRequired RuntimeMode = "approval-required"
	ModeAutoAcceptEdits  RuntimeMode = "auto-accept-edits"
	ModeAuto             RuntimeMode = "auto"
	ModeFullAccess       RuntimeMode = "full-access"
)

// AllowsUnprompted reports whether an action may run under this mode WITHOUT
// asking a human — the whole permission matrix, in one place:
//
//	                    read   mutating
//	full-access         run    run
//	auto                run    ask
//	auto-accept-edits   run    ask
//	approval-required   ask    ask
//
// `mutating` is the caller's own judgement about the action (for the SSH tool
// gate, sshtool.Classify's verdict). An unrecognised mode answers false: the
// conservative direction, matching sshtool.Classify's "when in doubt, gate it"
// philosophy.
//
// It lives on RuntimeMode rather than in the one service that first needed it
// because two separate places now have to agree on it, and they run at
// different times: service.SSHToolService decides whether to OPEN an approval
// card, and approval.Gate.ReleasePending decides whether a card already open
// should now close itself because the operator changed the mode while it was
// waiting. Two copies of this table would drift, and the failure mode of that
// drift is a card that can never be dismissed.
func (m RuntimeMode) AllowsUnprompted(mutating bool) bool {
	switch m {
	case ModeFullAccess:
		return true
	case ModeAuto, ModeAutoAcceptEdits:
		return !mutating
	case ModeApprovalRequired:
		return false
	default:
		return false
	}
}

// InteractionMode separates "collaboration style" from "permission policy".
// The two are orthogonal: plan mode still needs a runtime mode.
type InteractionMode string

const (
	InteractionDefault InteractionMode = "default"
	InteractionPlan    InteractionMode = "plan"
)

type SessionStartInput struct {
	ThreadID string
	Cwd      string
	Model    ModelSelection
	Mode     RuntimeMode
	Interact InteractionMode
	// ResumeCursor is an opaque value previously emitted by the adapter via
	// SessionStartedPayload.Resume. Orchestration stores it without reading it.
	ResumeCursor json.RawMessage
	// Env are per-SESSION environment overrides, layered on top of the
	// instance's own (InstanceSpec.Env) when the agent process is spawned.
	// Distinct from InstanceSpec.Env because the thing that varies here is the
	// thread, not the configured agent: an SSH chat thread prepends its own
	// workspace bin/ to PATH, where the devdeck-ssh shim lives, and that shim
	// is the only route its agent has to the remote host. An adapter that
	// spawns no process may ignore this.
	Env map[string]string
	// MCPEndpoints are injected if you mirror t3code's built-in MCP pattern.
	// Each entry is either HTTP (URL set — e.g. Hindsight's own MCP server)
	// or stdio (Command set — e.g. `devdeck mcp-server`, spawned as a
	// subprocess by the agent's own CLI). An adapter that doesn't support
	// MCP at all may ignore this field entirely.
	MCPEndpoints []MCPEndpoint
}

type MCPEndpoint struct {
	Name string
	// HTTP transport.
	URL   string
	Token string
	// Stdio transport. Command set means stdio; empty means HTTP (URL set
	// instead) — the two are mutually exclusive on one MCPEndpoint.
	Command string
	Args    []string
}

// ModelSelection is what the composer's picker sends with a turn. The tags
// are load-bearing, not cosmetic: this is decoded straight off the WebSocket
// as part of TurnStartPayload, and untagged Go field names would make the
// client send `{"InstanceID":…}`. Nothing shipped depended on the old shape —
// the frontend never sent this field at all, which is why the model pill was
// decorative until now.
type ModelSelection struct {
	// InstanceID names the agent to run this turn on. Empty means "whatever
	// the worktree is configured for"; a non-empty value that differs from the
	// thread's current binding switches it (see Reactor.ensureSession).
	InstanceID InstanceID     `json:"instanceId,omitempty"`
	Model      string         `json:"model,omitempty"`
	Options    map[string]any `json:"options,omitempty"` // effort, thinking, fastMode, ...
}

type Session struct {
	ThreadID          string
	ProviderSessionID string
	StartedAt         int64
	Model             string
}

type SendTurnInput struct {
	ThreadID    string
	TurnID      string
	Text        string
	Attachments []Attachment
	Mode        RuntimeMode
	Interact    InteractionMode
	Model       ModelSelection
}

// Attachment travels two ways: metadata-only over the WebSocket command
// channel (as part of TurnStartPayload — see orchestration/command.go), and
// with Data populated server-side once the Reactor loads the bytes from the
// attachment store (see orchestration/workers.go) before handing it to an
// Adapter's SendTurn. The JSON tags are load-bearing for the first leg, the
// same bug class ModelSelection was already fixed for (see its own comment,
// above): an untagged struct sends PascalCase keys the client never emits,
// silently dropping every field on decode.
type Attachment struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "image" | "file"
	MIME string `json:"mime"`
	Name string `json:"name"`
	Data []byte `json:"-"` // filled server-side from the store — see workers.go
	Path string `json:"-"` // unused today; kept, not serialized
}

type TurnStartResult struct {
	TurnID string
	// Steered = true when the provider folded this message into the turn
	// already in progress instead of starting a new one. Orchestration must
	// handle this case, not assume one send = one turn.
	Steered bool
}

type ThreadSnapshot struct {
	ThreadID string
	Turns    []TurnSnapshot
}

type TurnSnapshot struct {
	TurnID string
	Items  []json.RawMessage
}

// Adapter is the uniform contract orchestration sees. Every method must be
// safe to call from many goroutines.
type Adapter interface {
	Kind() Kind
	InstanceID() InstanceID
	Capabilities() Capabilities

	StartSession(ctx context.Context, in SessionStartInput) (Session, error)
	SendTurn(ctx context.Context, in SendTurnInput) (TurnStartResult, error)
	InterruptTurn(ctx context.Context, threadID, turnID string) error

	// RespondToRequest unblocks an agent that is waiting on an approval.
	RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error
	RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error

	// SetInteractionMode switches an already-running session's live
	// permission/collaboration mode (e.g. into or out of "plan") without a
	// restart. Verified viable on a live claude session (capture/README.md
	// "Open question 2") — providers that cannot do this (or have no notion
	// of interaction mode at all, e.g. pi) implement it as a no-op rather
	// than an error; Capabilities.SupportsPlanMode is what tells a caller
	// whether calling this does anything.
	SetInteractionMode(ctx context.Context, threadID string, mode InteractionMode) error

	// SetRuntimeMode pushes a changed permission policy (RuntimeMode) to an
	// already-running session, the same way SetInteractionMode pushes a
	// changed collaboration mode. Without this, RuntimeMode only ever reaches
	// a session at StartSession time (each adapter's own buildArgs /
	// approvalPolicyFor): the composer's Permission pill updates DevDeck's own
	// thread state, but the live process keeps enforcing whatever mode it was
	// launched with for the rest of its life — visibly, an operator who
	// switches to auto or full access keeps getting asked, and switching back
	// to approval-required looks like it never left it. Providers with no live
	// channel for this (or no notion of RuntimeMode at all, e.g. pi) implement
	// it as a no-op rather than a guess at an unverified RPC — see each
	// implementation's own doc comment for why.
	SetRuntimeMode(ctx context.Context, threadID string, mode RuntimeMode) error

	StopSession(ctx context.Context, threadID string) error
	StopAll(ctx context.Context) error
	HasSession(threadID string) bool
	ListSessions() []Session

	ReadThread(ctx context.Context, threadID string) (ThreadSnapshot, error)
	RollbackThread(ctx context.Context, threadID string, turns int) (ThreadSnapshot, error)

	// Events is ONE channel for the whole instance (not per thread).
	// Consumers filter by ThreadID. The channel is closed when the adapter
	// dies — consumers must treat that as a shutdown signal.
	Events() <-chan event.Event
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

var ErrUnknownDriver = errors.New("provider: unknown driver")
var ErrUnknownInstance = errors.New("provider: unknown instance")

// Registry keeps the (static) driver catalogue separate from the (dynamic)
// live instances.
type Registry struct {
	mu        sync.RWMutex
	drivers   map[Kind]Driver
	instances map[InstanceID]*liveInstance
}

type liveInstance struct {
	spec    InstanceSpec
	adapter Adapter
	cancel  context.CancelFunc
}

func NewRegistry(drivers ...Driver) *Registry {
	r := &Registry{
		drivers:   make(map[Kind]Driver, len(drivers)),
		instances: make(map[InstanceID]*liveInstance),
	}
	for _, d := range drivers {
		r.drivers[d.Kind()] = d
	}
	return r
}

func (r *Registry) Driver(k Kind) (Driver, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.drivers[k]
	return d, ok
}

// StartInstance builds a live adapter for a configured instance. parent
// binds the instance's lifetime; Stop cancels it.
func (r *Registry) StartInstance(parent context.Context, k Kind, spec InstanceSpec) (Adapter, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.drivers[k]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownDriver, k)
	}
	if _, exists := r.instances[spec.InstanceID]; exists {
		return nil, fmt.Errorf("provider: instance %s already running", spec.InstanceID)
	}

	ctx, cancel := context.WithCancel(parent)
	a, err := d.Create(ctx, spec)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("provider: create %s: %w", k, err)
	}
	r.instances[spec.InstanceID] = &liveInstance{spec: spec, adapter: a, cancel: cancel}
	return a, nil
}

func (r *Registry) Adapter(id InstanceID) (Adapter, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	inst, ok := r.instances[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownInstance, id)
	}
	return inst.adapter, nil
}

func (r *Registry) StopInstance(ctx context.Context, id InstanceID) error {
	r.mu.Lock()
	inst, ok := r.instances[id]
	if ok {
		delete(r.instances, id)
	}
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownInstance, id)
	}
	err := inst.adapter.StopAll(ctx)
	inst.cancel()
	return err
}

func (r *Registry) Adapters() []Adapter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Adapter, 0, len(r.instances))
	for _, inst := range r.instances {
		out = append(out, inst.adapter)
	}
	return out
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// ThreadDirectory maps a thread to the instance that owns it. This is what
// lets a caller refer only to a thread, not to an agent.
// t3code equivalent: ProviderSessionDirectory.
type ThreadDirectory interface {
	InstanceFor(threadID string) (InstanceID, bool)
	Bind(threadID string, id InstanceID)
	Unbind(threadID string)
}

// Service routes thread operations to the right adapter.
type Service struct {
	Registry *Registry
	Dir      ThreadDirectory
}

func (s *Service) adapterFor(threadID string) (Adapter, error) {
	id, ok := s.Dir.InstanceFor(threadID)
	if !ok {
		return nil, fmt.Errorf("provider: thread %s is not bound to an instance", threadID)
	}
	return s.Registry.Adapter(id)
}

func (s *Service) SendTurn(ctx context.Context, in SendTurnInput) (TurnStartResult, error) {
	a, err := s.adapterFor(in.ThreadID)
	if err != nil {
		return TurnStartResult{}, err
	}
	return a.SendTurn(ctx, in)
}

func (s *Service) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	a, err := s.adapterFor(threadID)
	if err != nil {
		return err
	}
	return a.RespondToRequest(ctx, threadID, requestID, d)
}

func (s *Service) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	a, err := s.adapterFor(threadID)
	if err != nil {
		return err
	}
	return a.RespondToUserInput(ctx, threadID, requestID, answers)
}

func (s *Service) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a, err := s.adapterFor(threadID)
	if err != nil {
		return err
	}
	return a.InterruptTurn(ctx, threadID, turnID)
}
