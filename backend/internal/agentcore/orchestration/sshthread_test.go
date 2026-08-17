package orchestration

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
)

func TestSSHThreadNamespace(t *testing.T) {
	if !IsSSHThread("ssh:c-1") {
		t.Fatal("ssh:c-1 not recognised as an SSH thread")
	}
	if IsSSHThread("w-abc") || IsSSHThread("w-abc::chat-2") {
		t.Fatal("worktree thread misread as SSH")
	}
	if got := SSHConnectionIDForThread("ssh:c-1::chat-3"); got != "c-1" {
		t.Fatalf("connection id = %q, want c-1", got)
	}
	if got := SSHThreadID("c-9"); got != "ssh:c-9" {
		t.Fatalf("thread id = %q, want ssh:c-9", got)
	}
}

func TestWorktreeIDForThreadStillIgnoresSSHThreads(t *testing.T) {
	// Guards the existing worktree path: it must not try to resolve an SSH id.
	if got := WorktreeIDForThread("w-abc::chat-2"); got != "w-abc" {
		t.Fatalf("worktree id = %q", got)
	}
}

// TestToolApprovalPrompterOpensAwaitsAndResolves exercises Ask end to end
// against the real engine + MemStore: Inject must land a genuine
// event.RequestOpened, Gate.Await must unblock once the request is
// resolved, and Ask must inject event.RequestResolved before returning so
// no card is left pending on the thread.
func TestToolApprovalPrompterOpensAwaitsAndResolves(t *testing.T) {
	st := NewMemStore()
	n := 0
	eng := NewEngine(EngineOptions{Store: st, NewID: func() string { n++; return "ae-" + strconv.Itoa(n) }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go eng.Run(ctx)

	if _, err := eng.Dispatch(ctx, Command{
		CommandID: "c-create", Type: CmdThreadCreate, ThreadID: "ssh:sc-1",
		Payload: []byte(`{"instanceId":"claude:default"}`),
	}); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	gate := approval.NewGate()
	in := NewIngestion(eng, gate, func() string { n++; return "ae-" + strconv.Itoa(n) })
	p := &ToolApprovalPrompter{Ingestion: in, Gate: gate}

	// Ask registers the request on the Gate (Ingestion.handle's Broker.Open,
	// driven by the Inject below) a full engine round-trip before it reaches
	// Gate.Await. Resolving once, as soon as the request exists at all, is
	// therefore enough — and deliberately so: a decision landing inside that
	// gap is precisely the case approval.Gate's tombstone exists to carry, so
	// this test doubles as its in-situ regression guard. It used to require a
	// resolver that kept firing forever, which is what a lost decision looks
	// like from the outside.
	go func() {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if err := gate.Resolve("tool-1", event.DecisionAccept); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	d, err := p.Ask(ctx, "ssh:sc-1", "tool-1", event.ReqCommandExecApproval, "systemctl restart nginx")
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if d != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", d, event.DecisionAccept)
	}

	// MemStore's replay method is EventsSince(ctx, seq) — it is not scoped
	// to a thread, unlike the plan's sketch — so filter for ssh:sc-1 below.
	evts, err := st.EventsSince(ctx, 0)
	if err != nil {
		t.Fatalf("EventsSince: %v", err)
	}
	var sawOpened, sawResolved bool
	for _, e := range evts {
		if e.ThreadID != "ssh:sc-1" {
			continue
		}
		if strings.Contains(string(e.Payload), string(event.RequestOpened)) {
			sawOpened = true
		}
		if strings.Contains(string(e.Payload), string(event.RequestResolved)) {
			sawResolved = true
		}
	}
	if !sawOpened || !sawResolved {
		t.Fatalf("event log missing request lifecycle: opened=%v resolved=%v", sawOpened, sawResolved)
	}
}
