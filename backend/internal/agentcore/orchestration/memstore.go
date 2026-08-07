package orchestration

import (
	"context"
	"sync"
)

// MemStore is the test double for Store. It exists so the engine's contract
// (idempotency, atomic commit, ordering) can be exercised without SQLite.
// Task 5 provides the real implementation; TestReplayDeterministic must pass
// against both.
type MemStore struct {
	mu       sync.Mutex
	log      []Event
	receipts map[string][]Event
	// FailCommit, when set, makes the next Commit fail. Used to prove the
	// engine does not swap state on a failed commit.
	FailCommit error
}

func NewMemStore() *MemStore {
	return &MemStore{receipts: make(map[string][]Event)}
}

func (m *MemStore) SeenCommand(_ context.Context, commandID string) ([]Event, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	evts, ok := m.receipts[commandID]
	return evts, ok, nil
}

func (m *MemStore) Commit(_ context.Context, commandID string, evts []Event) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailCommit != nil {
		err := m.FailCommit
		m.FailCommit = nil
		return nil, err
	}
	out := make([]Event, len(evts))
	for i, e := range evts {
		e.Seq = uint64(len(m.log) + i + 1)
		out[i] = e
	}
	m.log = append(m.log, out...)
	m.receipts[commandID] = out
	return out, nil
}

func (m *MemStore) EventsSince(_ context.Context, seq uint64) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Event
	for _, e := range m.log {
		if e.Seq > seq {
			out = append(out, e)
		}
	}
	return out, nil
}

// All returns the whole log, for replay tests.
func (m *MemStore) All() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Event(nil), m.log...)
}

var _ Store = (*MemStore)(nil)
