package approval

import (
	"context"
	"sync"

	"devdeck/backend/internal/agentcore/event"
)

// Gate is the blocking Broker implementation used by the SSH tool handlers
// (see backend/internal/service/ssh_tool.go and the design spec's §4.4). It
// satisfies the existing Broker interface for compatibility with the
// provider-driven approval flow, and additionally exposes Await: a call that
// genuinely blocks the calling goroutine until a decision arrives, the
// thread is cancelled, or ctx ends. That blocking primitive doesn't exist on
// MemoryBroker because nothing needed it there — DevDeck drives the claude
// CLI over stdin/stdout RPC. Here, an HTTP handler goroutine is parked
// waiting on a human, so something has to be able to actually block it.
type Gate struct {
	mu sync.Mutex

	// waiters holds one buffered (size 1) channel per pending requestID.
	// Buffered so Resolve never blocks handing off to a waiter that has
	// already given up (context cancelled, thread cancelled) and gone.
	waiters map[string]chan event.Decision

	// byThread indexes pending requestIDs by thread, so CancelThread can
	// find and decline every one of them.
	byThread map[string]map[string]bool

	// sessionAccepted marks threads where the user answered
	// DecisionAcceptForSession, so later mutating calls on that thread can
	// skip the prompt until ClearSession.
	sessionAccepted map[string]bool

	// OnCancel is called once per request CancelThread abandons — inherited
	// wholesale from MemoryBroker, which this type replaces in main.go. It is
	// how a request nobody can answer any more still gets a wire reply, so
	// the UI's RequestResolved event clears instead of leaving a ghost prompt.
	//
	// It fires for EVERY abandoned request, including this package's own
	// blocking ones. Requests that have no provider counterpart (the
	// tool-gate's "tool-" ids) are filtered by the callback main.go installs,
	// not here: which id shapes exist is orchestration's vocabulary, not the
	// gate's.
	OnCancel func(threadID, requestID string)
}

// NewGate returns a ready-to-use Gate.
func NewGate() *Gate {
	return &Gate{
		waiters:         make(map[string]chan event.Decision),
		byThread:        make(map[string]map[string]bool),
		sessionAccepted: make(map[string]bool),
	}
}

// Open registers a request as pending on a thread, so a later CancelThread
// can find and deny it. It is also implicitly called by Await; handlers that
// only need Broker semantics (no blocking wait) can call it directly.
func (g *Gate) Open(threadID, requestID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.open(threadID, requestID)
}

// open registers requestID as pending on threadID and ensures a waiter
// channel exists for it. Callers must hold g.mu.
func (g *Gate) open(threadID, requestID string) chan event.Decision {
	ch, ok := g.waiters[requestID]
	if !ok {
		ch = make(chan event.Decision, 1)
		g.waiters[requestID] = ch
	}
	if g.byThread[threadID] == nil {
		g.byThread[threadID] = make(map[string]bool)
	}
	g.byThread[threadID][requestID] = true
	return ch
}

// Resolve delivers a decision to a waiting caller. It returns
// ErrUnknownRequest if requestID is not (or is no longer) pending — the
// benign shape of a double-tap from a second device, or a decision that
// arrived after the waiter's context already ended.
func (g *Gate) Resolve(requestID string, d event.Decision) error {
	g.mu.Lock()
	ch, ok := g.waiters[requestID]
	if !ok {
		g.mu.Unlock()
		return ErrUnknownRequest
	}
	delete(g.waiters, requestID)
	for threadID, reqs := range g.byThread {
		if reqs[requestID] {
			delete(reqs, requestID)
			if len(reqs) == 0 {
				delete(g.byThread, threadID)
			}
			if d == event.DecisionAcceptForSession {
				g.sessionAccepted[threadID] = true
			}
			break
		}
	}
	g.mu.Unlock()

	// Buffered size 1: this never blocks, even if Await already returned
	// (e.g. via context cancellation) and nobody will ever read ch again.
	ch <- d
	return nil
}

// CancelThread abandons every pending request on a thread, resolving each
// as event.DecisionDecline, and clears the thread's session-accept flag.
// Called when a session exits or a turn is interrupted — without it, an
// Await goroutine (and the HTTP request parked on it) would hang forever.
func (g *Gate) CancelThread(threadID string) {
	g.mu.Lock()
	reqs := g.byThread[threadID]
	ids := make([]string, 0, len(reqs))
	for id := range reqs {
		ids = append(ids, id)
	}
	delete(g.byThread, threadID)
	delete(g.sessionAccepted, threadID)

	chans := make([]chan event.Decision, 0, len(ids))
	for _, id := range ids {
		if ch, ok := g.waiters[id]; ok {
			chans = append(chans, ch)
			delete(g.waiters, id)
		}
	}
	cb := g.OnCancel
	g.mu.Unlock()

	for _, ch := range chans {
		ch <- event.DecisionDecline
	}
	if cb == nil {
		return
	}
	for _, id := range ids {
		cb(threadID, id)
	}
}

// Await registers requestID as pending on threadID (if not already, e.g. via
// a prior Open) and blocks until Resolve delivers a decision, CancelThread
// declines it, or ctx ends. Either way the request is removed before Await
// returns — a context timeout does not leak a pending waiter; a later
// Resolve for the same requestID returns ErrUnknownRequest.
func (g *Gate) Await(ctx context.Context, threadID, requestID string) (event.Decision, error) {
	g.mu.Lock()
	ch := g.open(threadID, requestID)
	g.mu.Unlock()

	select {
	case d := <-ch:
		return d, nil
	case <-ctx.Done():
		g.remove(threadID, requestID)
		return "", ctx.Err()
	}
}

// remove drops requestID from the pending sets without delivering a
// decision — used when Await gives up because ctx ended.
func (g *Gate) remove(threadID, requestID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.waiters, requestID)
	if reqs := g.byThread[threadID]; reqs != nil {
		delete(reqs, requestID)
		if len(reqs) == 0 {
			delete(g.byThread, threadID)
		}
	}
}

// pending reports whether requestID currently has a waiter registered.
// Unexported: it exists to let tests synchronize on Await having registered
// its request before they act on it (e.g. before calling CancelThread).
func (g *Gate) pending(requestID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, ok := g.waiters[requestID]
	return ok
}

// SessionAccepted reports whether threadID answered a prior request with
// event.DecisionAcceptForSession and has not since been cleared.
func (g *Gate) SessionAccepted(threadID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.sessionAccepted[threadID]
}

// ClearSession clears the session-accept flag for threadID.
func (g *Gate) ClearSession(threadID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.sessionAccepted, threadID)
}

var _ Broker = (*Gate)(nil)
