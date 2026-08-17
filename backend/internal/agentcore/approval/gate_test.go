package approval

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
)

func TestAwaitReturnsResolvedDecision(t *testing.T) {
	g := NewGate()
	go func() {
		// Resolve may land before Await registers; the gate must tolerate
		// either order, so retry briefly.
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if err := g.Resolve("tool-1", event.DecisionAccept); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	d, err := g.Await(context.Background(), "ssh:c-1", "tool-1")
	if err != nil {
		t.Fatalf("Await: %v", err)
	}
	if d != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", d, event.DecisionAccept)
	}
}

func TestCancelThreadDeclinesPendingRequests(t *testing.T) {
	g := NewGate()
	done := make(chan event.Decision, 1)
	go func() {
		d, _ := g.Await(context.Background(), "ssh:c-1", "tool-2")
		done <- d
	}()
	waitForPending(t, g, "tool-2")
	g.CancelThread("ssh:c-1")
	select {
	case d := <-done:
		if d != event.DecisionDecline {
			t.Fatalf("decision = %q, want %q", d, event.DecisionDecline)
		}
	case <-time.After(time.Second):
		t.Fatal("Await did not return after CancelThread")
	}
}

func TestAwaitHonoursContextCancellation(t *testing.T) {
	g := NewGate()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Await(ctx, "ssh:c-1", "tool-3"); err == nil {
		t.Fatal("want error from cancelled context")
	}
	if err := g.Resolve("tool-3", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("request leaked: %v", err)
	}
}

func TestAcceptForSessionSetsThreadFlag(t *testing.T) {
	g := NewGate()
	go func() {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if err := g.Resolve("tool-4", event.DecisionAcceptForSession); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if _, err := g.Await(context.Background(), "ssh:c-2", "tool-4"); err != nil {
		t.Fatalf("Await: %v", err)
	}
	if !g.SessionAccepted("ssh:c-2") {
		t.Fatal("session-accept flag not set")
	}
	g.ClearSession("ssh:c-2")
	if g.SessionAccepted("ssh:c-2") {
		t.Fatal("session-accept flag survived ClearSession")
	}
}

func TestResolveUnknownRequest(t *testing.T) {
	if err := NewGate().Resolve("nope", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("err = %v, want ErrUnknownRequest", err)
	}
}

// The gap these two tests close is structural, not hypothetical: a request is
// registered by Ingestion.handle (Broker.Open) when the card is published, and
// the goroutine that will wait on it only reaches Await one engine round-trip
// later. Anything landing in that gap — a second device answering, or far more
// realistically an interrupt firing CancelThread — used to delete the
// registration and hand the decision to a channel nobody would ever read,
// leaving Await parked on a fresh channel until its 10-minute ceiling. The
// caller parked there is an HTTP handler holding an SSH exec, so "eventually
// times out" is not an acceptable answer.
func TestResolveLandingBeforeAwaitIsStillDelivered(t *testing.T) {
	g := NewGate()
	g.Open("ssh:sc-1", "tool-early") // what Ingestion does when the card is published
	if err := g.Resolve("tool-early", event.DecisionAccept); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	d, err := g.Await(ctx, "ssh:sc-1", "tool-early") // Ask only gets here now
	if err != nil {
		t.Fatalf("Await after an early Resolve: %v", err)
	}
	if d != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", d, event.DecisionAccept)
	}
}

func TestCancelLandingBeforeAwaitIsStillDelivered(t *testing.T) {
	g := NewGate()
	g.Open("ssh:sc-1", "tool-early")
	g.CancelThread("ssh:sc-1")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	d, err := g.Await(ctx, "ssh:sc-1", "tool-early")
	if err != nil {
		t.Fatalf("Await after an early CancelThread blocked instead of returning: %v", err)
	}
	if d != event.DecisionDecline {
		t.Fatalf("decision = %q, want %q", d, event.DecisionDecline)
	}
}

// A decision nobody ever waits for must not accumulate: every provider-driven
// request goes Open -> Resolve with no Await at all.
func TestUnconsumedDecisionsExpire(t *testing.T) {
	g := NewGate()
	g.tombstoneTTL = 10 * time.Millisecond

	g.Open("ssh:sc-1", "tool-orphan")
	if err := g.Resolve("tool-orphan", event.DecisionAccept); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	g.Open("ssh:sc-1", "tool-other") // any call sweeps

	if g.tracked("tool-orphan") {
		t.Fatal("an unconsumed decision was retained past its TTL")
	}
}

// Gate replaces MemoryBroker in main.go, so it has to carry MemoryBroker's
// one behaviour that is not on the Broker interface: the OnCancel fan-out
// that tells whoever writes the wire reply to deny a request the user can no
// longer answer. Dropping it would silently reintroduce the ghost prompts
// MemoryBroker.OnCancel's doc comment exists to prevent.
func TestCancelThreadFiresOnCancelForEveryPendingRequest(t *testing.T) {
	g := NewGate()
	var mu sync.Mutex
	var got []string
	g.OnCancel = func(threadID, requestID string) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, threadID+"/"+requestID)
	}

	g.Open("ssh:sc-1", "req-a")
	g.Open("ssh:sc-1", "req-b")
	g.Open("ssh:sc-2", "req-c")
	g.CancelThread("ssh:sc-1")

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("OnCancel fired %d times (%v), want 2", len(got), got)
	}
	for _, id := range got {
		if !strings.HasPrefix(id, "ssh:sc-1/") {
			t.Fatalf("OnCancel fired for another thread's request: %s", id)
		}
	}
}

func TestResolveDoesNotFireOnCancel(t *testing.T) {
	g := NewGate()
	fired := false
	g.OnCancel = func(string, string) { fired = true }

	g.Open("ssh:sc-1", "req-a")
	if err := g.Resolve("req-a", event.DecisionAccept); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if fired {
		t.Fatal("OnCancel fired for a request the user actually answered")
	}
}

func waitForPending(t *testing.T, g *Gate, requestID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if g.pending(requestID) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("request %s never became pending", requestID)
}
