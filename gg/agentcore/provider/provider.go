// Package provider berisi dua abstraksi inti: Driver (konfigurasi + pabrik)
// dan Adapter (runtime hidup). Pemisahan ini yang membuat lapisan orchestration
// tidak pernah tahu agent mana yang ada di balik sebuah thread.
//
// Padanan t3code:
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

	"example.com/agentcore/event"
)

// Kind adalah identitas jenis driver: "claude", "codex", "cursor", ...
type Kind string

// InstanceID adalah identitas satu instance terkonfigurasi.
// PENTING: ini bukan Kind. Satu user bisa punya dua instance "claude" dengan
// akun/HOME berbeda. t3code menempuh migrasi menyakitkan karena awalnya
// merutekan pakai Kind — mulailah dengan InstanceID sejak hari pertama.
type InstanceID string

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// Driver adalah nilai deklaratif, bukan proses. Dia tahu cara membaca config
// dan cara membuat Adapter; dia tidak menyimpan state runtime.
type Driver interface {
	Kind() Kind

	// DefaultConfig mengembalikan config kosong yang valid.
	DefaultConfig() json.RawMessage

	// DecodeConfig memvalidasi config mentah milik instance.
	// Kembalikan error yang jelas — ini yang dilihat user di UI settings.
	DecodeConfig(raw json.RawMessage) (Config, error)

	// Probe memeriksa apakah provider ini bisa dipakai: binary ada? versi
	// berapa? sudah login? model apa saja yang tersedia?
	// Dipanggil periodik, harus murah dan tidak boleh menyentuh sesi hidup.
	Probe(ctx context.Context, cfg Config) (Snapshot, error)

	// Create membangun Adapter hidup. ctx yang diberikan mengikat umur
	// adapter: saat ctx dibatalkan, semua proses anak harus mati.
	Create(ctx context.Context, spec InstanceSpec) (Adapter, error)
}

// Config adalah config yang sudah tervalidasi. Tiap driver punya tipe konkret
// sendiri; interface ini cuma penanda.
type Config interface{ ProviderKind() Kind }

type InstanceSpec struct {
	InstanceID  InstanceID
	DisplayName string
	Config      Config
	Env         map[string]string
	Enabled     bool
}

// Snapshot adalah status provider yang ditampilkan di UI.
type Snapshot struct {
	InstanceID   InstanceID
	Kind         Kind
	Available    bool
	Version      string
	BinaryPath   string
	Authed       bool
	AccountLabel string
	Models       []Model
	Detail       string // alasan kalau Available == false
}

type Model struct {
	Slug         string
	Name         string
	Capabilities map[string]any // effort, thinking, dst — bentuknya per-provider
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

// SessionModelSwitch mendeklarasikan apakah model bisa diganti di tengah sesi.
// Claude bisa; sebagian provider harus start ulang sesi. Orchestration perlu
// tahu ini supaya bisa memutuskan restart atau tidak.
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

// RuntimeMode memetakan kebijakan izin yang seragam ke padanan tiap provider.
// t3code: approval-required | auto-accept-edits | auto | full-access.
type RuntimeMode string

const (
	ModeApprovalRequired RuntimeMode = "approval-required"
	ModeAutoAcceptEdits  RuntimeMode = "auto-accept-edits"
	ModeAuto             RuntimeMode = "auto"
	ModeFullAccess       RuntimeMode = "full-access"
)

// InteractionMode memisahkan "gaya kolaborasi" dari "kebijakan izin".
// Keduanya orthogonal: plan mode tetap butuh runtime mode.
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
	// ResumeCursor adalah nilai buram yang dulu dikeluarkan adapter lewat
	// SessionStartedPayload.Resume. Orchestration menyimpannya tanpa membaca.
	ResumeCursor json.RawMessage
	// MCPEndpoint disuntikkan kalau kamu meniru pola MCP bawaan t3code.
	MCPEndpoint *MCPEndpoint
}

type MCPEndpoint struct {
	Name  string
	URL   string
	Token string
}

type ModelSelection struct {
	InstanceID InstanceID
	Model      string
	Options    map[string]any // effort, thinking, fastMode, ...
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

type Attachment struct {
	Kind string // "image" | "file"
	MIME string
	Name string
	Data []byte
	Path string
}

type TurnStartResult struct {
	TurnID string
	// Steered = true kalau provider menggabungkan pesan ini ke turn yang
	// sedang berjalan alih-alih memulai turn baru. Orchestration harus
	// menangani kasus ini, bukan mengasumsikan 1 kirim = 1 turn.
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

// Adapter adalah kontrak seragam yang dilihat orchestration. Semua metode
// harus aman dipanggil dari banyak goroutine.
type Adapter interface {
	Kind() Kind
	InstanceID() InstanceID
	Capabilities() Capabilities

	StartSession(ctx context.Context, in SessionStartInput) (Session, error)
	SendTurn(ctx context.Context, in SendTurnInput) (TurnStartResult, error)
	InterruptTurn(ctx context.Context, threadID, turnID string) error

	// RespondToRequest membuka blokir agent yang sedang menunggu approval.
	RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error
	RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error

	StopSession(ctx context.Context, threadID string) error
	StopAll(ctx context.Context) error
	HasSession(threadID string) bool
	ListSessions() []Session

	ReadThread(ctx context.Context, threadID string) (ThreadSnapshot, error)
	RollbackThread(ctx context.Context, threadID string, turns int) (ThreadSnapshot, error)

	// Events adalah SATU channel untuk seluruh instance (bukan per thread).
	// Konsumen memfilter berdasarkan ThreadID. Channel ditutup saat adapter
	// mati — konsumen harus memperlakukan itu sebagai sinyal shutdown.
	Events() <-chan event.Event
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

var ErrUnknownDriver = errors.New("provider: driver tidak dikenal")
var ErrUnknownInstance = errors.New("provider: instance tidak dikenal")

// Registry memisahkan katalog driver (statis) dari instance hidup (dinamis).
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

// StartInstance membuat adapter hidup untuk sebuah instance terkonfigurasi.
// parent mengikat umur instance; Stop membatalkannya.
func (r *Registry) StartInstance(parent context.Context, k Kind, spec InstanceSpec) (Adapter, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.drivers[k]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownDriver, k)
	}
	if _, exists := r.instances[spec.InstanceID]; exists {
		return nil, fmt.Errorf("provider: instance %s sudah jalan", spec.InstanceID)
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

// ThreadDirectory memetakan thread -> instance pemiliknya. Ini yang membuat
// pemanggil cukup menyebut thread, bukan agent.
// Padanan t3code: ProviderSessionDirectory.
type ThreadDirectory interface {
	InstanceFor(threadID string) (InstanceID, bool)
	Bind(threadID string, id InstanceID)
	Unbind(threadID string)
}

// Service merutekan operasi thread ke adapter yang benar.
type Service struct {
	Registry *Registry
	Dir      ThreadDirectory
}

func (s *Service) adapterFor(threadID string) (Adapter, error) {
	id, ok := s.Dir.InstanceFor(threadID)
	if !ok {
		return nil, fmt.Errorf("provider: thread %s belum terikat ke instance", threadID)
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

func (s *Service) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a, err := s.adapterFor(threadID)
	if err != nil {
		return err
	}
	return a.InterruptTurn(ctx, threadID, turnID)
}
