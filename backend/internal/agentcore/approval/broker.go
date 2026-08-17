// Package approval bridges the asymmetry at the heart of agent permissions:
// the agent calls and blocks, but the answer arrives from a completely
// different direction (an HTTP request from the user), possibly minutes
// later and possibly from a different device.
//
// There is no blocking primitive here (no Await) — DevDeck drives the
// claude CLI over stdin/stdout RPC, not a callback-style SDK, so there is no
// adapter goroutine to unblock. See the design spec's correction to
// gg/HANDOFF.md section 6. What this package IS responsible for: knowing
// which requestIds are open on which thread, and fanning a thread-wide
// cancellation out to whoever must write the wire reply.
package approval

import (
	"errors"

	"devdeck/backend/internal/agentcore/event"
)

// ErrUnknownRequest means the request id is not (or is no longer) pending.
// Callers treat this as benign: it is what a double-tap from a second device
// looks like.
var ErrUnknownRequest = errors.New("approval: unknown request")

// Broker unblocks an agent goroutine that is waiting on a user decision.
type Broker interface {
	// Open registers a request as pending on a thread, so a later
	// CancelThread can find and deny it.
	Open(threadID, requestID string)

	// Resolve delivers a decision to a waiting caller.
	Resolve(requestID string, d event.Decision) error

	// CancelThread abandons every pending request on a thread. Called when a
	// session exits or a turn is interrupted — without it the UI shows ghost
	// prompts that can never be answered.
	CancelThread(threadID string)
}

// NoopBroker satisfies Broker without tracking anything — used wherever a
// provider never opens a request through this package (e.g. pi today).
type NoopBroker struct{}

func (NoopBroker) Open(string, string)                  {}
func (NoopBroker) Resolve(string, event.Decision) error { return ErrUnknownRequest }
func (NoopBroker) CancelThread(string)                  {}

var _ Broker = NoopBroker{}
