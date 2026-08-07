package orchestration

import "context"

// EventStore is the narrow slice of persistence this package needs. It is
// declared HERE, by the consumer, rather than imported from port — that is
// what keeps the decider and engine tests free of SQLite while still routing
// every real write through the one port.Store implementation.
//
// backend/internal/store.Store satisfies this.
type EventStore interface {
	CommitAgentEvents(commandID string, evts []Event) ([]Event, error)
	SeenAgentCommand(commandID string) ([]Event, bool, error)
	AgentEventsSince(threadID string, seq uint64) ([]Event, error)
}

// portStore adapts an EventStore to the context-taking Store the engine uses.
type portStore struct{ es EventStore }

// NewPortStore wraps a persistent EventStore for the engine.
func NewPortStore(es EventStore) Store { return &portStore{es: es} }

func (p *portStore) SeenCommand(_ context.Context, commandID string) ([]Event, bool, error) {
	return p.es.SeenAgentCommand(commandID)
}

func (p *portStore) Commit(_ context.Context, commandID string, evts []Event) ([]Event, error) {
	return p.es.CommitAgentEvents(commandID, evts)
}

// EventsSince spans all threads for reconciliation; the per-thread variant
// used by the WebSocket handler calls the store directly.
//
// AgentEventsSince("", seq) returns nothing, because no thread has an empty
// id. That is intentional for spec 1: the engine's cross-thread
// reconciliation path is unused, and the WebSocket handler queries per
// thread. This is not a bug.
func (p *portStore) EventsSince(_ context.Context, seq uint64) ([]Event, error) {
	return p.es.AgentEventsSince("", seq)
}
