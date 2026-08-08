package orchestration

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"example.com/agentcore/event"
	"example.com/agentcore/provider"
)

// memStore adalah Store in-memory. Untuk produksi ganti dengan SQL, tapi
// perhatikan: Commit HARUS satu transaksi (append + projeksi + receipt).
type memStore struct {
	mu       sync.Mutex
	events   []Event
	receipts map[string][]Event
	seq      uint64
}

func newMemStore() *memStore { return &memStore{receipts: map[string][]Event{}} }

func (m *memStore) SeenCommand(_ context.Context, id string) ([]Event, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.receipts[id]
	return e, ok, nil
}

func (m *memStore) Commit(_ context.Context, id string, evts []Event) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Event, len(evts))
	for i, e := range evts {
		m.seq++
		e.Seq = m.seq
		out[i] = e
		m.events = append(m.events, e)
	}
	m.receipts[id] = out
	return out, nil
}

func (m *memStore) EventsSince(_ context.Context, seq uint64) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Event
	for _, e := range m.events {
		if e.Seq > seq {
			out = append(out, e)
		}
	}
	return out, nil
}

func newTestEngine(t *testing.T) (*Engine, *memStore, context.CancelFunc) {
	t.Helper()
	store := newMemStore()
	var n int
	e := NewEngine(EngineOptions{
		Store: store,
		NewID: func() string { n++; return fmt.Sprintf("ev-%d", n) },
		Now:   func() int64 { return 1_700_000_000 },
	})
	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	return e, store, cancel
}

func mustDispatch(t *testing.T, e *Engine, cmd Command) []Event {
	t.Helper()
	evts, err := e.Dispatch(context.Background(), cmd)
	if err != nil {
		t.Fatalf("dispatch %s: %v", cmd.Type, err)
	}
	return evts
}

func TestLifecycleThreadSampaiApproval(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()

	mustDispatch(t, e, Command{
		CommandID: "c1", Type: CmdThreadCreate, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"instanceId": "claude-1", "mode": "approval-required"}),
	})

	if th, _ := e.State().Thread("t1"); th.Status != ThreadIdle {
		t.Fatalf("status awal = %s, mau idle", th.Status)
	}

	mustDispatch(t, e, Command{
		CommandID: "c2", Type: CmdThreadTurnStart, ThreadID: "t1",
		Payload: mustJSON(TurnStartPayload{Text: "halo"}),
	})

	if th, _ := e.State().Thread("t1"); th.Status != ThreadRunning {
		t.Fatalf("setelah turn.start = %s, mau running", th.Status)
	}

	// Ingestion mencatat approval menggantung.
	mustDispatch(t, e, Command{
		CommandID: "c3", Type: CmdThreadSessionSet, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"pendingRequestAdd": "req-1"}),
	})

	th, _ := e.State().Thread("t1")
	if th.Status != ThreadWaiting || !th.PendingRequests["req-1"] {
		t.Fatalf("mau waiting dengan req-1, dapat %s %v", th.Status, th.PendingRequests)
	}

	mustDispatch(t, e, Command{
		CommandID: "c4", Type: CmdThreadApprovalRespond, ThreadID: "t1",
		Payload: mustJSON(ApprovalRespondPayload{RequestID: "req-1", Decision: event.DecisionAccept}),
	})

	th, _ = e.State().Thread("t1")
	if th.Status != ThreadRunning || len(th.PendingRequests) != 0 {
		t.Fatalf("setelah approve mau running & kosong, dapat %s %v", th.Status, th.PendingRequests)
	}
}

// Ini invariant yang menyelamatkanmu saat WebSocket putus dan client
// mengirim ulang command yang sama.
func TestIdempotensiCommandID(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	mustDispatch(t, e, Command{
		CommandID: "c1", Type: CmdThreadCreate, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"instanceId": "claude-1"}),
	})
	before := len(store.events)

	// Kirim ulang persis sama.
	mustDispatch(t, e, Command{
		CommandID: "c1", Type: CmdThreadCreate, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"instanceId": "claude-1"}),
	})

	if len(store.events) != before {
		t.Fatalf("retry menghasilkan event baru: %d -> %d", before, len(store.events))
	}
}

// Approval ganda dari dua device tidak boleh menghasilkan dua event.
func TestApprovalDoubleTapDitolak(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()

	mustDispatch(t, e, Command{CommandID: "c1", Type: CmdThreadCreate, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"instanceId": "claude-1"})})
	mustDispatch(t, e, Command{CommandID: "c2", Type: CmdThreadSessionSet, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"pendingRequestAdd": "req-1"})})
	mustDispatch(t, e, Command{CommandID: "c3", Type: CmdThreadApprovalRespond, ThreadID: "t1",
		Payload: mustJSON(ApprovalRespondPayload{RequestID: "req-1", Decision: event.DecisionAccept})})

	// CommandID berbeda (device lain), request sama.
	_, err := e.Dispatch(context.Background(), Command{
		CommandID: "c4", Type: CmdThreadApprovalRespond, ThreadID: "t1",
		Payload: mustJSON(ApprovalRespondPayload{RequestID: "req-1", Decision: event.DecisionDecline}),
	})
	if err == nil {
		t.Fatal("approval kedua seharusnya ditolak")
	}
}

// Replay dari nol wajib menghasilkan state identik — ini definisi
// event-sourcing yang benar. Kalau tes ini gagal, ada projector yang
// membaca sesuatu di luar event (jam, random, state luar).
func TestReplayDeterministik(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	mustDispatch(t, e, Command{CommandID: "c1", Type: CmdThreadCreate, ThreadID: "t1",
		Payload: mustJSON(map[string]any{"instanceId": "claude-1"})})
	mustDispatch(t, e, Command{CommandID: "c2", Type: CmdThreadTurnStart, ThreadID: "t1",
		Payload: mustJSON(TurnStartPayload{Text: "halo"})})
	mustDispatch(t, e, Command{CommandID: "c3", Type: CmdThreadRuntimeModeSet, ThreadID: "t1",
		Payload: mustJSON(RuntimeModeSetPayload{Mode: provider.ModeAutoAcceptEdits})})

	all, _ := store.EventsSince(context.Background(), 0)
	replayed := Apply(NewState(), all)

	live, _ := json.Marshal(e.State())
	rebuilt, _ := json.Marshal(replayed)
	if string(live) != string(rebuilt) {
		t.Fatalf("replay tidak identik:\nlive    = %s\nrebuilt = %s", live, rebuilt)
	}
}
