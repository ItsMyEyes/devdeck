package approval

import (
	"context"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
)

// defaultTombstoneTTL bounds how long a decision nobody has collected is kept
// (see gateEntry.decided). Long enough to cover the one engine round-trip
// between publishing an approval card and parking on it, short enough that a
// provider-driven request — which is opened and resolved with no Await
// anywhere — costs a map entry for seconds, not for the process's life.
const defaultTombstoneTTL = 2 * time.Minute

// Gate is the blocking Broker implementation behind the SSH tool handlers
// (see backend/internal/service/ssh_tool.go and the design spec's §4.4). It
// satisfies Broker, so it drops into the provider-driven approval flow
// unchanged, and adds Await: a call that genuinely blocks its goroutine until
// a decision arrives, the thread is cancelled, or ctx ends.
//
// That blocking primitive did not exist on the broker Gate replaces, because
// nothing needed it: DevDeck answers a provider's approval by writing to a
// CLI's stdin, which is a write, not a hand-off. Here the caller is an HTTP
// handler holding an SSH connection open while it waits on a human, so
// something has to actually park it.
//
// The subtlety worth knowing before changing anything here: a request is
// registered (Open, called by Ingestion when the card is published) strictly
// BEFORE the goroutine that will wait on it reaches Await. Anything that
// resolves the request inside that gap — a second device, or an interrupt
// firing CancelThread — must still be delivered to the Await that arrives
// afterwards. That is what the decided/tombstone half of gateEntry is for.
// Deleting a resolved entry outright, the obvious implementation, strands the
// waiter until its context expires.
type Gate struct {
	mu sync.Mutex

	// entries holds one record per known requestID: a live waiter, a decision
	// waiting to be collected, or both.
	entries map[string]*gateEntry

	// byThread indexes requestIDs by thread so CancelThread can find every
	// request a dying thread leaves behind.
	byThread map[string]map[string]bool

	// sessionAccepted marks threads where the user answered
	// DecisionAcceptForSession, so later mutating calls on that thread can
	// skip the prompt until ClearSession.
	sessionAccepted map[string]bool

	// tombstoneTTL is defaultTombstoneTTL outside tests.
	tombstoneTTL time.Duration

	// OnCancel is called once per request CancelThread abandons — inherited
	// wholesale from the MemoryBroker this type replaces. It is how a request
	// nobody can answer any more still gets a wire reply, so the UI's
	// RequestResolved event clears instead of leaving a ghost prompt.
	//
	// It fires for every request CancelThread actually abandons, including
	// this package's own blocking ones. Requests that have no provider
	// counterpart (the tool gate's "tool-" ids) are filtered by the callback
	// main.go installs, not here: which id shapes exist is orchestration's
	// vocabulary, not the gate's.
	OnCancel func(threadID, requestID string)
}

// gateEntry is one request's state. A request is created by Open or Await,
// and lives until either a waiter collects its decision or its tombstone
// expires.
type gateEntry struct {
	// ch is buffered (size 1) so delivering a decision never blocks on a
	// waiter that has already given up and gone.
	ch       chan event.Decision
	threadID string

	// decided records a decision that has been delivered but not necessarily
	// collected. decidedAt starts the tombstone's clock.
	decided   bool
	decision  event.Decision
	decidedAt time.Time
}

// NewGate returns a ready-to-use Gate.
func NewGate() *Gate {
	return &Gate{
		entries:         make(map[string]*gateEntry),
		byThread:        make(map[string]map[string]bool),
		sessionAccepted: make(map[string]bool),
		tombstoneTTL:    defaultTombstoneTTL,
	}
}

// Open registers a request as pending on a thread, so a later CancelThread
// can find and deny it. Await opens implicitly; this exists for the Broker
// path, where Ingestion registers a provider's request that no goroutine in
// this process is waiting on.
func (g *Gate) Open(threadID, requestID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sweepLocked()
	g.openLocked(threadID, requestID)
}

// openLocked returns requestID's entry, creating it if needed. Callers must
// hold g.mu.
func (g *Gate) openLocked(threadID, requestID string) *gateEntry {
	e, ok := g.entries[requestID]
	if !ok {
		e = &gateEntry{ch: make(chan event.Decision, 1), threadID: threadID}
		g.entries[requestID] = e
	}
	if g.byThread[threadID] == nil {
		g.byThread[threadID] = make(map[string]bool)
	}
	g.byThread[threadID][requestID] = true
	return e
}

// dropLocked removes a request from both indexes. Callers must hold g.mu.
func (g *Gate) dropLocked(requestID string) {
	e, ok := g.entries[requestID]
	if !ok {
		return
	}
	delete(g.entries, requestID)
	if reqs := g.byThread[e.threadID]; reqs != nil {
		delete(reqs, requestID)
		if len(reqs) == 0 {
			delete(g.byThread, e.threadID)
		}
	}
}

// sweepLocked discards decisions nobody collected within tombstoneTTL. Called
// from every public method, so the map stays bounded without a goroutine or a
// timer. Callers must hold g.mu.
func (g *Gate) sweepLocked() {
	if g.tombstoneTTL <= 0 {
		return
	}
	cutoff := time.Now().Add(-g.tombstoneTTL)
	for id, e := range g.entries {
		if e.decided && e.decidedAt.Before(cutoff) {
			g.dropLocked(id)
		}
	}
}

// Resolve delivers a decision to requestID. It returns ErrUnknownRequest when
// the request is unknown or was already decided — the benign shape of a
// double-tap from a second device.
//
// The entry is deliberately NOT removed here. An Await that has not yet
// reached its select must still be able to collect this decision; the
// tombstone is what makes that work, and sweepLocked is what keeps it from
// accumulating.
func (g *Gate) Resolve(requestID string, d event.Decision) error {
	g.mu.Lock()
	g.sweepLocked()
	e, ok := g.entries[requestID]
	if !ok || e.decided {
		g.mu.Unlock()
		return ErrUnknownRequest
	}
	e.decided, e.decision, e.decidedAt = true, d, time.Now()
	if d == event.DecisionAcceptForSession {
		g.sessionAccepted[e.threadID] = true
	}
	ch := e.ch
	g.mu.Unlock()

	// Buffered size 1, and each entry is decided exactly once, so this never
	// blocks — with or without a live waiter.
	ch <- d
	return nil
}

// CancelThread abandons every request still open on a thread, declining each
// one, and clears the thread's session-accept flag. Called when a session
// exits or a turn is interrupted: without it, an Await goroutine — and the
// HTTP request parked on it — would wait out its whole ceiling for an answer
// that can no longer come.
func (g *Gate) CancelThread(threadID string) {
	g.mu.Lock()
	g.sweepLocked()
	delete(g.sessionAccepted, threadID)

	now := time.Now()
	abandoned := make([]string, 0, len(g.byThread[threadID]))
	chans := make([]chan event.Decision, 0, len(g.byThread[threadID]))
	for id := range g.byThread[threadID] {
		e := g.entries[id]
		if e == nil || e.decided {
			continue // already answered; its tombstone expires on its own
		}
		e.decided, e.decision, e.decidedAt = true, event.DecisionDecline, now
		abandoned = append(abandoned, id)
		chans = append(chans, e.ch)
	}
	g.mu.Unlock()

	for _, ch := range chans {
		ch <- event.DecisionDecline
	}
	if g.OnCancel == nil {
		return
	}
	for _, id := range abandoned {
		g.OnCancel(threadID, id)
	}
}

// Await registers requestID on threadID (if Open has not already) and blocks
// until a decision arrives, the thread is cancelled, or ctx ends. A decision
// that landed before this call collects immediately. The request is removed
// on every exit path, so a timed-out Await leaks nothing and a later Resolve
// for the same id reports ErrUnknownRequest.
func (g *Gate) Await(ctx context.Context, threadID, requestID string) (event.Decision, error) {
	g.mu.Lock()
	g.sweepLocked()
	e := g.openLocked(threadID, requestID)
	if e.decided {
		d := e.decision
		g.dropLocked(requestID)
		g.mu.Unlock()
		return d, nil
	}
	ch := e.ch
	g.mu.Unlock()

	select {
	case d := <-ch:
		g.mu.Lock()
		g.dropLocked(requestID)
		g.mu.Unlock()
		return d, nil
	case <-ctx.Done():
		g.mu.Lock()
		g.dropLocked(requestID)
		g.mu.Unlock()
		return "", ctx.Err()
	}
}

// pending reports whether requestID is registered and still unanswered.
// Unexported: it lets tests synchronize on Await having registered its
// request before they act on it.
func (g *Gate) pending(requestID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	e, ok := g.entries[requestID]
	return ok && !e.decided
}

// tracked reports whether requestID is known at all, answered or not.
// Unexported: it lets a test prove tombstones are actually reclaimed.
func (g *Gate) tracked(requestID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, ok := g.entries[requestID]
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
