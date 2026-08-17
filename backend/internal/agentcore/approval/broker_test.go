package approval

// TestNoopBrokerImplementsOpen used to live in memory_broker_test.go
// (deleted alongside memory_broker.go — see gate.go's doc comment for why
// Gate replaces it). NoopBroker itself is unrelated to MemoryBroker/Gate —
// it lives in broker.go — so its one-line coverage moved here rather than
// disappearing with the file it happened to be declared in.

import "testing"

func TestNoopBrokerImplementsOpen(t *testing.T) {
	var _ Broker = NoopBroker{}
	NoopBroker{}.Open("w-abc", "req-1") // must not panic
}
