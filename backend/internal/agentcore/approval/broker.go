// Package approval bridges the asymmetry at the heart of agent permissions:
// the agent calls and blocks, but the answer arrives from a completely
// different direction (an HTTP request from the user), possibly minutes later
// and possibly from a different device.
//
// Spec 1 ships the interface and a no-op only. The blocking implementation
// (Await + pendingApprovals) lands in spec 2 together with the four traps
// documented in gg/HANDOFF.md section 6.
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
	// Resolve delivers a decision to a waiting caller.
	Resolve(requestID string, d event.Decision) error

	// CancelThread abandons every pending request on a thread. Called when a
	// session exits or a turn is interrupted — without it the UI shows ghost
	// prompts that can never be answered.
	CancelThread(threadID string)
}

// NoopBroker satisfies Broker without blocking anything. Used in spec 1,
// where no adapter opens a request yet.
type NoopBroker struct{}

func (NoopBroker) Resolve(string, event.Decision) error { return ErrUnknownRequest }
func (NoopBroker) CancelThread(string)                  {}

var _ Broker = NoopBroker{}
