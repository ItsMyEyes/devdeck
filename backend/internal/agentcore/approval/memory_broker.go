package approval

import (
	"sync"

	"devdeck/backend/internal/agentcore/event"
)

// MemoryBroker is the real Broker: an in-memory, per-process registry of
// open requestIds per thread, plus cancellation fan-out. It carries no
// provider-specific metadata (tool_use_id, raw input, permission_suggestions
// — those live in the claude package's parseState/pendingRequest, per
// event.go's no-leak rule) — only enough to answer "which requests are open
// on this thread" and "tell whoever writes the wire reply to deny them."
type MemoryBroker struct {
	mu       sync.Mutex
	byThread map[string]map[string]struct{} // threadID -> requestIDs
	byReq    map[string]string              // requestID -> threadID, for O(1) Resolve

	// OnCancel is called once per request CancelThread abandons — set by
	// main.go to provider.Service.RespondToRequest(ctx, threadID, requestID,
	// event.DecisionCancel). A process death (no live session) makes that
	// write fail; it is discarded on purpose — the point is retiring the
	// bookkeeping so the UI's RequestResolved event still clears.
	OnCancel func(threadID, requestID string)
}

func (b *MemoryBroker) Open(threadID, requestID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byThread == nil {
		b.byThread = make(map[string]map[string]struct{})
		b.byReq = make(map[string]string)
	}
	if b.byThread[threadID] == nil {
		b.byThread[threadID] = make(map[string]struct{})
	}
	b.byThread[threadID][requestID] = struct{}{}
	b.byReq[requestID] = threadID
}

func (b *MemoryBroker) Resolve(requestID string, _ event.Decision) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	threadID, ok := b.byReq[requestID]
	if !ok {
		return ErrUnknownRequest
	}
	delete(b.byReq, requestID)
	if reqs := b.byThread[threadID]; reqs != nil {
		delete(reqs, requestID)
	}
	return nil
}

func (b *MemoryBroker) CancelThread(threadID string) {
	b.mu.Lock()
	reqs := b.byThread[threadID]
	ids := make([]string, 0, len(reqs))
	for id := range reqs {
		ids = append(ids, id)
	}
	for _, id := range ids {
		delete(b.byReq, id)
	}
	delete(b.byThread, threadID)
	cb := b.OnCancel
	b.mu.Unlock()

	if cb == nil {
		return
	}
	for _, id := range ids {
		cb(threadID, id)
	}
}

var _ Broker = (*MemoryBroker)(nil)
