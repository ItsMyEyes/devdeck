package approval

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
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

// ── ReleasePending: the permission pill has to mean something WHILE a card is up ──
//
// service.SSHToolService reads the thread's mode once, decides to ask, and then
// parks on Await. Before ReleasePending existed, an operator who answered a
// blocking prompt by switching the thread to full access watched nothing
// happen — the mode they had just chosen said "never ask", and the question
// already in flight had no way to hear about it.
func TestReleasePendingUnblocksAwaitUnderFullAccess(t *testing.T) {
	g := NewGate()
	done := make(chan event.Decision, 1)
	go func() {
		d, err := g.AwaitClass(context.Background(), "t-1", "tool-1", true)
		if err != nil {
			t.Errorf("AwaitClass: %v", err)
		}
		done <- d
	}()
	waitForPending(t, g, "tool-1")

	released := g.ReleasePending("t-1", provider.ModeFullAccess)
	if len(released) != 1 || released[0] != "tool-1" {
		t.Fatalf("ReleasePending = %v, want [tool-1]", released)
	}
	if got := <-done; got != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", got, event.DecisionAccept)
	}
}

// The whole reason `auto` is a distinct mode from `full-access`: it stops
// gating reads and keeps gating everything that changes the host. Switching to
// it must release one and not the other.
func TestReleasePendingUnderAutoReleasesReadsOnly(t *testing.T) {
	g := NewGate()
	readDone := make(chan event.Decision, 1)
	go func() {
		d, _ := g.AwaitClass(context.Background(), "t-1", "tool-read", false)
		readDone <- d
	}()
	writeCtx, cancelWrite := context.WithCancel(context.Background())
	defer cancelWrite()
	go func() { _, _ = g.AwaitClass(writeCtx, "t-1", "tool-write", true) }()
	waitForPending(t, g, "tool-read")
	waitForPending(t, g, "tool-write")

	released := g.ReleasePending("t-1", provider.ModeAuto)
	if len(released) != 1 || released[0] != "tool-read" {
		t.Fatalf("ReleasePending = %v, want [tool-read] only", released)
	}
	if got := <-readDone; got != event.DecisionAccept {
		t.Fatalf("read decision = %q, want %q", got, event.DecisionAccept)
	}
	if !g.pending("tool-write") {
		t.Fatal("the write must still be waiting on the operator under auto")
	}
}

// approval-required promises to ask every time — selecting it can never be
// what answers a question.
func TestReleasePendingUnderApprovalRequiredReleasesNothing(t *testing.T) {
	g := NewGate()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _, _ = g.AwaitClass(ctx, "t-1", "tool-read", false) }()
	waitForPending(t, g, "tool-read")

	if released := g.ReleasePending("t-1", provider.ModeApprovalRequired); len(released) != 0 {
		t.Fatalf("ReleasePending = %v, want none", released)
	}
	if !g.pending("tool-read") {
		t.Fatal("request must still be pending")
	}
}

// A request registered through Open alone — the Broker path, where a provider
// raised the card and nothing in this process waits on it — declares no class.
// Silence has to read as "assume it changes the host", or a mode switch to
// `auto` would auto-accept a provider's file write.
func TestReleasePendingTreatsUnclassifiedRequestsAsMutating(t *testing.T) {
	g := NewGate()
	g.Open("t-1", "req-provider")

	if released := g.ReleasePending("t-1", provider.ModeAuto); len(released) != 0 {
		t.Fatalf("ReleasePending under auto = %v, want none", released)
	}
	if released := g.ReleasePending("t-1", provider.ModeFullAccess); len(released) != 1 {
		t.Fatalf("ReleasePending under full-access = %v, want the request", released)
	}
}

// Scoped to one thread, like CancelThread — a mode change on one SSH thread
// must not answer a card open on another.
func TestReleasePendingIsScopedToItsThread(t *testing.T) {
	g := NewGate()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _, _ = g.AwaitClass(ctx, "t-other", "tool-other", true) }()
	waitForPending(t, g, "tool-other")

	if released := g.ReleasePending("t-1", provider.ModeFullAccess); len(released) != 0 {
		t.Fatalf("ReleasePending = %v, want none", released)
	}
	if !g.pending("tool-other") {
		t.Fatal("the other thread's request must be untouched")
	}
}

// Releasing must not set the standing session flag. The mode is now the
// durable permission and it is visible in the composer; sessionAccepted is a
// separate, hidden grant the operator makes explicitly by clicking for it.
func TestReleasePendingDoesNotSetSessionAccepted(t *testing.T) {
	g := NewGate()
	done := make(chan struct{})
	go func() {
		_, _ = g.AwaitClass(context.Background(), "t-1", "tool-1", true)
		close(done)
	}()
	waitForPending(t, g, "tool-1")

	g.ReleasePending("t-1", provider.ModeFullAccess)
	<-done
	if g.SessionAccepted("t-1") {
		t.Fatal("ReleasePending must not grant a standing session accept")
	}
}

// An already-answered request has a tombstone, not a waiter. Releasing must
// skip it rather than deliver a second decision onto its channel.
func TestReleasePendingSkipsAlreadyDecidedRequests(t *testing.T) {
	g := NewGate()
	g.Open("t-1", "req-1")
	if err := g.Resolve("req-1", event.DecisionDecline); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if released := g.ReleasePending("t-1", provider.ModeFullAccess); len(released) != 0 {
		t.Fatalf("ReleasePending = %v, want none", released)
	}
	d, err := g.Await(context.Background(), "t-1", "req-1")
	if err != nil {
		t.Fatalf("Await: %v", err)
	}
	if d != event.DecisionDecline {
		t.Fatalf("decision = %q, want the original %q", d, event.DecisionDecline)
	}
}
