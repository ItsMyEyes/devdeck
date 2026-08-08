// Package approval mengelola permintaan yang memblokir agent sampai user
// menjawab. Ini bagian yang paling sering salah diimplementasikan.
//
// Bentuk masalahnya: agent memanggil callback/RPC dan MENUNGGU. Jawabannya
// datang dari arah lain sama sekali — HTTP/WebSocket request user, mungkin
// beberapa menit kemudian, mungkin dari perangkat berbeda. Broker inilah
// jembatannya.
//
// Padanan t3code: Deferred + Map pendingApprovals di ClaudeAdapter.ts
// (lihat canUseToolEffect di sekitar baris 3870-4025).
package approval

import (
	"context"
	"errors"
	"sync"
	"time"

	"example.com/agentcore/event"
)

var (
	ErrUnknownRequest = errors.New("approval: request tidak dikenal atau sudah selesai")
	ErrBrokerClosed   = errors.New("approval: broker sudah ditutup")
)

type pending struct {
	threadID string
	reqType  event.RequestType
	openedAt time.Time
	ch       chan event.Decision
	// Suggestions dipakai saat decision == acceptForSession: aturan izin yang
	// dikirim balik ke provider supaya tidak menanya hal serupa lagi.
	Suggestions []any
}

// Broker aman dipanggil dari banyak goroutine.
type Broker struct {
	mu      sync.Mutex
	waiting map[string]*pending
	closed  bool
}

func New() *Broker {
	return &Broker{waiting: make(map[string]*pending)}
}

// Await dipanggil DARI DALAM adapter, di goroutine yang sedang menahan agent.
// Dia blokir sampai salah satu terjadi:
//   - user memutuskan       -> keputusan user
//   - ctx dibatalkan        -> DecisionCancel (agent interrupt / sesi mati)
//
// Adapter WAJIB memancarkan RequestOpened SEBELUM memanggil Await, dan
// RequestResolved SESUDAHNYA. Kalau tidak, UI tidak akan pernah menampilkan
// prompt dan agent menggantung selamanya.
func (b *Broker) Await(ctx context.Context, requestID, threadID string, t event.RequestType) (event.Decision, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return event.DecisionCancel, ErrBrokerClosed
	}
	p := &pending{
		threadID: threadID,
		reqType:  t,
		openedAt: time.Now(),
		ch:       make(chan event.Decision, 1),
	}
	b.waiting[requestID] = p
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.waiting, requestID)
		b.mu.Unlock()
	}()

	select {
	case d := <-p.ch:
		return d, nil
	case <-ctx.Done():
		// Ini jalur abort. t3code memasang listener pada AbortSignal untuk
		// hal yang sama. Tanpa ini, interrupt di tengah approval akan
		// membuat sesi menggantung.
		return event.DecisionCancel, nil
	}
}

// Resolve dipanggil dari arah user (handler RPC/HTTP). Non-blocking.
// Aman dipanggil dua kali — yang kedua mengembalikan ErrUnknownRequest,
// yang benar karena user bisa saja menekan tombol dua kali dari dua device.
func (b *Broker) Resolve(requestID string, d event.Decision) error {
	if !d.Valid() {
		return errors.New("approval: decision tidak valid")
	}
	b.mu.Lock()
	p, ok := b.waiting[requestID]
	if ok {
		delete(b.waiting, requestID)
	}
	b.mu.Unlock()
	if !ok {
		return ErrUnknownRequest
	}
	p.ch <- d
	return nil
}

// CancelThread membatalkan semua request menggantung milik satu thread.
// Panggil saat sesi berhenti, turn di-interrupt, atau proses provider mati.
func (b *Broker) CancelThread(threadID string) int {
	b.mu.Lock()
	var victims []*pending
	for id, p := range b.waiting {
		if p.threadID == threadID {
			victims = append(victims, p)
			delete(b.waiting, id)
		}
	}
	b.mu.Unlock()
	for _, p := range victims {
		p.ch <- event.DecisionCancel
	}
	return len(victims)
}

// Close membatalkan semuanya. Dipanggil saat server shutdown.
func (b *Broker) Close() {
	b.mu.Lock()
	b.closed = true
	victims := make([]*pending, 0, len(b.waiting))
	for id, p := range b.waiting {
		victims = append(victims, p)
		delete(b.waiting, id)
	}
	b.mu.Unlock()
	for _, p := range victims {
		p.ch <- event.DecisionCancel
	}
}

// PendingInfo dipakai untuk rehidrasi UI: client yang baru connect harus
// langsung melihat prompt yang masih menunggu.
type PendingInfo struct {
	RequestID string
	ThreadID  string
	Type      event.RequestType
	OpenedAt  time.Time
}

func (b *Broker) Pending(threadID string) []PendingInfo {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []PendingInfo
	for id, p := range b.waiting {
		if threadID != "" && p.threadID != threadID {
			continue
		}
		out = append(out, PendingInfo{
			RequestID: id, ThreadID: p.threadID, Type: p.reqType, OpenedAt: p.openedAt,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Kebijakan mode: satu-satunya tempat RuntimeMode diterjemahkan.
// ---------------------------------------------------------------------------

// SessionGrants menyimpan izin "accept for session" per thread supaya
// pertanyaan yang sama tidak ditanyakan berulang dalam satu sesi.
type SessionGrants struct {
	mu     sync.RWMutex
	grants map[string]map[string]bool // threadID -> grantKey -> true
}

func NewSessionGrants() *SessionGrants {
	return &SessionGrants{grants: make(map[string]map[string]bool)}
}

func (g *SessionGrants) Grant(threadID, key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.grants[threadID] == nil {
		g.grants[threadID] = make(map[string]bool)
	}
	g.grants[threadID][key] = true
}

func (g *SessionGrants) Granted(threadID, key string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.grants[threadID][key]
}

func (g *SessionGrants) ClearThread(threadID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.grants, threadID)
}
