package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"example.com/agentcore/provider"
)

// ---------------------------------------------------------------------------
// State & projeksi
// ---------------------------------------------------------------------------

type ThreadStatus string

const (
	ThreadIdle    ThreadStatus = "idle"
	ThreadRunning ThreadStatus = "running"
	ThreadWaiting ThreadStatus = "waiting" // menunggu approval/input user
	ThreadStopped ThreadStatus = "stopped"
)

type Thread struct {
	ID          string
	InstanceID  provider.InstanceID
	Status      ThreadStatus
	Mode        provider.RuntimeMode
	Interact    provider.InteractionMode
	CurrentTurn string
	// ResumeCursor: nilai buram dari adapter. Engine menyimpan, tidak membaca.
	ResumeCursor    json.RawMessage
	PendingRequests map[string]bool
	Deleted         bool
	UpdatedAt       int64
}

// State adalah read model in-memory. Immutable secara konvensi: projector
// mengembalikan salinan baru, bukan memutasi yang lama. Itu yang membuat
// "swap setelah commit" di bawah aman.
type State struct {
	Threads map[string]*Thread
}

func NewState() *State { return &State{Threads: make(map[string]*Thread)} }

func (s *State) clone() *State {
	n := &State{Threads: make(map[string]*Thread, len(s.Threads))}
	for k, v := range s.Threads {
		c := *v
		c.PendingRequests = make(map[string]bool, len(v.PendingRequests))
		for r := range v.PendingRequests {
			c.PendingRequests[r] = true
		}
		n.Threads[k] = &c
	}
	return n
}

func (s *State) Thread(id string) (*Thread, bool) {
	t, ok := s.Threads[id]
	return t, ok
}

// ---------------------------------------------------------------------------
// Decider — MURNI. Tanpa I/O, tanpa jam, tanpa random.
// ---------------------------------------------------------------------------

// Decide mengubah (state, command) menjadi event. Ini satu-satunya tempat
// aturan bisnis boleh hidup.
//
// Kemurnian di sini bukan idealisme: karena murni, seluruh aturan sistemmu
// bisa diuji dengan tabel input/output tanpa database, tanpa proses agent.
// Begitu kamu memasukkan time.Now() ke sini, kamu kehilangan itu — makanya
// `now` dioper sebagai parameter.
func Decide(s *State, cmd Command, now int64, newID func() string) ([]Event, error) {
	mk := func(t EventType, payload any) Event {
		var raw json.RawMessage
		if payload != nil {
			b, _ := json.Marshal(payload)
			raw = b
		}
		return Event{
			EventID:   newID(),
			Type:      t,
			ThreadID:  cmd.ThreadID,
			CommandID: cmd.CommandID,
			CreatedAt: now,
			Payload:   raw,
		}
	}

	switch cmd.Type {
	case CmdThreadCreate:
		if _, exists := s.Threads[cmd.ThreadID]; exists {
			return nil, fmt.Errorf("thread %s sudah ada", cmd.ThreadID)
		}
		return []Event{mk(EvtThreadCreated, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadTurnStart:
		t, ok := s.Threads[cmd.ThreadID]
		if !ok || t.Deleted {
			return nil, fmt.Errorf("thread %s tidak ada", cmd.ThreadID)
		}
		// Catatan desain: kita TIDAK menolak saat thread sedang running.
		// Provider modern mendukung "steering" — pesan menyusul digabung ke
		// turn berjalan. Adapter yang memutuskan, lewat TurnStartResult.Steered.
		var p TurnStartPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, fmt.Errorf("payload turn.start tidak valid: %w", err)
		}
		if p.Text == "" && len(p.Attachments) == 0 {
			return nil, errors.New("turn kosong")
		}
		return []Event{
			mk(EvtThreadMessageSent, p),
			mk(EvtThreadTurnStartRequested, p),
		}, nil

	case CmdThreadApprovalRespond:
		t, ok := s.Threads[cmd.ThreadID]
		if !ok {
			return nil, fmt.Errorf("thread %s tidak ada", cmd.ThreadID)
		}
		var p ApprovalRespondPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, err
		}
		if !p.Decision.Valid() {
			return nil, errors.New("decision tidak valid")
		}
		// Menolak request yang tidak menggantung membuat double-tap dari dua
		// device tidak menghasilkan dua event.
		if !t.PendingRequests[p.RequestID] {
			return nil, fmt.Errorf("request %s tidak menggantung", p.RequestID)
		}
		return []Event{mk(EvtThreadApprovalResponseRequested, p)}, nil

	case CmdThreadTurnInterrupt:
		return []Event{mk(EvtThreadTurnInterruptRequested, nil)}, nil

	case CmdThreadSessionStop:
		return []Event{mk(EvtThreadSessionStopRequested, nil)}, nil

	case CmdThreadRuntimeModeSet:
		var p RuntimeModeSetPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return nil, err
		}
		return []Event{mk(EvtThreadRuntimeModeSet, p)}, nil

	case CmdThreadAssistantDelta:
		return []Event{mk(EvtThreadActivityAppended, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadSessionSet:
		return []Event{mk(EvtThreadSessionSet, json.RawMessage(cmd.Payload))}, nil

	case CmdThreadDelete:
		return []Event{mk(EvtThreadDeleted, nil)}, nil

	default:
		return nil, fmt.Errorf("command tidak dikenal: %s", cmd.Type)
	}
}

// ---------------------------------------------------------------------------
// Projector — juga murni.
// ---------------------------------------------------------------------------

// Apply menurunkan state baru dari event. Harus deterministik: replay seluruh
// event log dari awal wajib menghasilkan state yang identik.
func Apply(s *State, evts []Event) *State {
	next := s.clone()
	for _, e := range evts {
		applyOne(next, e)
	}
	return next
}

func applyOne(s *State, e Event) {
	switch e.Type {
	case EvtThreadCreated:
		var p struct {
			InstanceID provider.InstanceID      `json:"instanceId"`
			Mode       provider.RuntimeMode     `json:"mode"`
			Interact   provider.InteractionMode `json:"interactionMode"`
		}
		_ = json.Unmarshal(e.Payload, &p)
		if p.Mode == "" {
			p.Mode = provider.ModeApprovalRequired
		}
		if p.Interact == "" {
			p.Interact = provider.InteractionDefault
		}
		s.Threads[e.ThreadID] = &Thread{
			ID: e.ThreadID, InstanceID: p.InstanceID, Status: ThreadIdle,
			Mode: p.Mode, Interact: p.Interact,
			PendingRequests: map[string]bool{}, UpdatedAt: e.CreatedAt,
		}

	case EvtThreadTurnStartRequested:
		if t, ok := s.Threads[e.ThreadID]; ok {
			t.Status = ThreadRunning
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadApprovalResponseRequested:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p ApprovalRespondPayload
			_ = json.Unmarshal(e.Payload, &p)
			delete(t.PendingRequests, p.RequestID)
			if len(t.PendingRequests) == 0 && t.Status == ThreadWaiting {
				t.Status = ThreadRunning
			}
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadRuntimeModeSet:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p RuntimeModeSetPayload
			_ = json.Unmarshal(e.Payload, &p)
			t.Mode = p.Mode
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadSessionSet:
		if t, ok := s.Threads[e.ThreadID]; ok {
			var p struct {
				Status       ThreadStatus    `json:"status"`
				ResumeCursor json.RawMessage `json:"resumeCursor,omitempty"`
				PendingAdd   string          `json:"pendingRequestAdd,omitempty"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.Status != "" {
				t.Status = p.Status
			}
			if len(p.ResumeCursor) > 0 {
				t.ResumeCursor = p.ResumeCursor
			}
			if p.PendingAdd != "" {
				t.PendingRequests[p.PendingAdd] = true
				t.Status = ThreadWaiting
			}
			t.UpdatedAt = e.CreatedAt
		}

	case EvtThreadDeleted:
		if t, ok := s.Threads[e.ThreadID]; ok {
			t.Deleted = true
			t.Status = ThreadStopped
		}
	}
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// Store harus mengeksekusi append + projeksi + receipt dalam SATU transaksi.
// Kalau tidak, read model bisa berbeda permanen dari event log setelah crash.
type Store interface {
	// SeenCommand mengembalikan event hasil command tsb kalau sudah pernah
	// diproses (idempotensi).
	SeenCommand(ctx context.Context, commandID string) ([]Event, bool, error)

	// Commit menjalankan satu transaksi: assign Seq, append event, tulis
	// receipt, jalankan sideEffects (projeksi ke tabel baca) — semuanya
	// atomik. Kembalikan event yang sudah ber-Seq.
	Commit(ctx context.Context, commandID string, evts []Event) ([]Event, error)

	// EventsSince dipakai untuk rekonsiliasi setelah kegagalan dispatch.
	EventsSince(ctx context.Context, seq uint64) ([]Event, error)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type envelope struct {
	ctx   context.Context
	cmd   Command
	reply chan result
}

type result struct {
	events []Event
	err    error
}

// Engine menyerialkan seluruh pemrosesan command lewat SATU goroutine.
// Ini bukan bottleneck yang kelihatannya: decider murni dan cepat; yang lambat
// (panggilan ke provider) terjadi di reactor, di luar loop ini.
//
// Serialisasi total inilah yang membuat decider boleh menganggap state-nya
// stabil selama menghitung. Tanpa itu kamu butuh locking per-thread dan semua
// invariant jadi rapuh.
type Engine struct {
	store Store
	queue chan envelope
	newID func() string
	now   func() int64

	mu    sync.RWMutex
	state *State

	subsMu sync.RWMutex
	subs   map[int]chan []Event
	nextID int

	closeOnce sync.Once
	done      chan struct{}
}

type EngineOptions struct {
	Store   Store
	Initial *State
	NewID   func() string
	Now     func() int64
	// QueueSize: 0 = unbuffered. Buffered lebih baik supaya reactor tidak
	// terblokir saat engine sibuk, tapi jangan besar — antrean panjang
	// menyembunyikan masalah throughput.
	QueueSize int
}

func NewEngine(o EngineOptions) *Engine {
	if o.Initial == nil {
		o.Initial = NewState()
	}
	if o.Now == nil {
		o.Now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Engine{
		store: o.Store,
		queue: make(chan envelope, o.QueueSize),
		newID: o.NewID,
		now:   o.Now,
		state: o.Initial,
		subs:  make(map[int]chan []Event),
		done:  make(chan struct{}),
	}
}

// Run menjalankan worker. Panggil di goroutine sendiri; blokir sampai ctx mati.
func (e *Engine) Run(ctx context.Context) {
	defer e.closeSubs()
	for {
		select {
		case <-ctx.Done():
			return
		case env := <-e.queue:
			evts, err := e.process(env.ctx, env.cmd)
			env.reply <- result{events: evts, err: err}
		}
	}
}

// Dispatch mengantre command dan menunggu hasilnya.
func (e *Engine) Dispatch(ctx context.Context, cmd Command) ([]Event, error) {
	if cmd.CommandID == "" {
		return nil, errors.New("engine: CommandID wajib (dipakai untuk idempotensi)")
	}
	reply := make(chan result, 1)
	select {
	case e.queue <- envelope{ctx: ctx, cmd: cmd, reply: reply}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-e.done:
		return nil, errors.New("engine: sudah berhenti")
	}
	select {
	case r := <-reply:
		return r.events, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (e *Engine) process(ctx context.Context, cmd Command) ([]Event, error) {
	// 1. Idempotensi.
	if prior, seen, err := e.store.SeenCommand(ctx, cmd.CommandID); err != nil {
		return nil, err
	} else if seen {
		return prior, nil
	}

	// 2. Decide (murni).
	e.mu.RLock()
	cur := e.state
	e.mu.RUnlock()

	evts, err := Decide(cur, cmd, e.now(), e.newID)
	if err != nil {
		return nil, err
	}
	if len(evts) == 0 {
		return nil, nil
	}

	// 3. Commit atomik.
	committed, err := e.store.Commit(ctx, cmd.CommandID, evts)
	if err != nil {
		return nil, err
	}

	// 4. Swap state SETELAH commit sukses. Urutan ini penting: kalau kamu
	//    swap dulu lalu commit gagal, read model in-memory memuat fakta yang
	//    tidak pernah ada di log.
	e.mu.Lock()
	e.state = Apply(e.state, committed)
	e.mu.Unlock()

	// 5. Publish ke subscriber (reactor + client). Setelah commit, selalu.
	e.publish(committed)
	return committed, nil
}

func (e *Engine) State() *State {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.state
}

// Subscribe mengembalikan channel event yang sudah commit, plus fungsi
// unsubscribe. Channel di-buffer; subscriber lambat akan kehilangan event
// (lihat catatan drop di publish) — jadi subscriber wajib cepat, atau
// menyalin ke antrean sendiri.
func (e *Engine) Subscribe(buf int) (<-chan []Event, func()) {
	e.subsMu.Lock()
	defer e.subsMu.Unlock()
	id := e.nextID
	e.nextID++
	ch := make(chan []Event, buf)
	e.subs[id] = ch
	return ch, func() {
		e.subsMu.Lock()
		defer e.subsMu.Unlock()
		if c, ok := e.subs[id]; ok {
			delete(e.subs, id)
			close(c)
		}
	}
}

func (e *Engine) publish(evts []Event) {
	e.subsMu.RLock()
	defer e.subsMu.RUnlock()
	for _, ch := range e.subs {
		select {
		case ch <- evts:
		default:
			// Sengaja drop ketimbang memblokir loop command. Subscriber yang
			// butuh jaminan wajib membaca ulang lewat Store.EventsSince(seq)
			// memakai Seq terakhir yang dia lihat.
		}
	}
}

func (e *Engine) closeSubs() {
	e.closeOnce.Do(func() { close(e.done) })
	e.subsMu.Lock()
	defer e.subsMu.Unlock()
	for id, ch := range e.subs {
		delete(e.subs, id)
		close(ch)
	}
}
