package approval

import (
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func TestMemoryBrokerResolveDeliversToOnResolveNotOnCancel(t *testing.T) {
	b := &MemoryBroker{}
	b.Open("w-abc", "req-1")
	if err := b.Resolve("req-1", event.DecisionAccept); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// Resolved requests are retired — a second Resolve is unknown.
	if err := b.Resolve("req-1", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("second resolve = %v, want ErrUnknownRequest", err)
	}
}

func TestMemoryBrokerCancelThreadFansOutToEveryOpenRequest(t *testing.T) {
	var cancelled []string
	b := &MemoryBroker{OnCancel: func(threadID, requestID string) { cancelled = append(cancelled, threadID+"/"+requestID) }}
	b.Open("w-abc", "req-1")
	b.Open("w-abc", "req-2")
	b.Open("w-def", "req-3") // a different thread — must not be touched

	b.CancelThread("w-abc")

	if len(cancelled) != 2 {
		t.Fatalf("cancelled = %v, want exactly 2 (req-1, req-2)", cancelled)
	}
	// Cancelled requests are retired.
	if err := b.Resolve("req-1", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("resolve after cancel = %v, want ErrUnknownRequest", err)
	}
	// The untouched thread's request is still open.
	if err := b.Resolve("req-3", event.DecisionAccept); err != nil {
		t.Fatalf("resolve on untouched thread: %v", err)
	}
}

func TestMemoryBrokerResolveUnknownRequestIsBenign(t *testing.T) {
	b := &MemoryBroker{}
	if err := b.Resolve("never-opened", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("err = %v, want ErrUnknownRequest — a double-tap from a second device must be benign", err)
	}
}

func TestMemoryBrokerCancelThreadWithNoOpenRequestsIsANoop(t *testing.T) {
	called := false
	b := &MemoryBroker{OnCancel: func(string, string) { called = true }}
	b.CancelThread("w-nothing-pending")
	if called {
		t.Fatal("OnCancel must not fire for a thread with nothing open")
	}
}

func TestNoopBrokerImplementsOpen(t *testing.T) {
	var _ Broker = NoopBroker{}
	NoopBroker{}.Open("w-abc", "req-1") // must not panic
}
