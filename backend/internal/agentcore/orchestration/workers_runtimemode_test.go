package orchestration

import (
	"context"
	"sync"
	"testing"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/provider"
)

// releasingBroker is a Broker that also satisfies pendingReleaser, recording
// what the Reactor asked it to release.
type releasingBroker struct {
	approval.NoopBroker

	mu    sync.Mutex
	calls []releaseCall
}

type releaseCall struct {
	threadID string
	mode     provider.RuntimeMode
}

func (b *releasingBroker) ReleasePending(threadID string, mode provider.RuntimeMode) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, releaseCall{threadID: threadID, mode: mode})
	return []string{"tool-1"}
}

func (b *releasingBroker) recorded() []releaseCall {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]releaseCall(nil), b.calls...)
}

// EvtThreadRuntimeModeSet is in IntentEvents, so it always reached the
// Reactor's switch — and, until this case existed, fell through it to
// `return nil`. That was almost enough: SSHToolService reads the thread's mode
// fresh on every call, so the NEXT tool call already obeyed a mode change. But
// a call currently BLOCKED on an approval card has already read it, so an
// operator who switched to full access to get past a prompt watched the prompt
// they were dismissing keep waiting for them.
func TestReactorReleasesPendingApprovalsOnRuntimeModeChange(t *testing.T) {
	b := &releasingBroker{}
	r := &Reactor{Broker: b}

	err := r.react(context.Background(), Event{
		Type:     EvtThreadRuntimeModeSet,
		ThreadID: "ssh:sc-1",
		Payload:  mustJSON(RuntimeModeSetPayload{Mode: provider.ModeFullAccess}),
	})
	if err != nil {
		t.Fatalf("react: %v", err)
	}

	calls := b.recorded()
	if len(calls) != 1 {
		t.Fatalf("ReleasePending calls = %d, want 1", len(calls))
	}
	if calls[0].threadID != "ssh:sc-1" {
		t.Errorf("threadID = %q, want ssh:sc-1", calls[0].threadID)
	}
	// The NEW mode has to travel, not the one the thread had when the card
	// went up — re-running the matrix against the old mode would release
	// nothing, every time.
	if calls[0].mode != provider.ModeFullAccess {
		t.Errorf("mode = %q, want %q", calls[0].mode, provider.ModeFullAccess)
	}
}

// Whether anything is actually released is the GATE's decision, not this
// switch's — it holds each open request's class and re-runs the same matrix
// SSHToolService used to open the card. The Reactor forwards `auto` exactly as
// it forwards `full-access`, and the gate is what declines to release a
// pending write under it.
func TestReactorForwardsAutoUnchanged(t *testing.T) {
	b := &releasingBroker{}
	r := &Reactor{Broker: b}

	if err := r.react(context.Background(), Event{
		Type:     EvtThreadRuntimeModeSet,
		ThreadID: "ssh:sc-1",
		Payload:  mustJSON(RuntimeModeSetPayload{Mode: provider.ModeAuto}),
	}); err != nil {
		t.Fatalf("react: %v", err)
	}

	calls := b.recorded()
	if len(calls) != 1 || calls[0].mode != provider.ModeAuto {
		t.Fatalf("calls = %+v, want one call carrying auto", calls)
	}
}

// A Broker with no blocking waiters — the provider-driven path, where DevDeck
// answers by writing to a CLI's stdin and parks no goroutine of its own — has
// nothing to release. It must not be obliged to carry a stub, and reaching it
// must not panic.
func TestReactorIgnoresBrokersThatCannotRelease(t *testing.T) {
	r := &Reactor{Broker: approval.NoopBroker{}}

	if err := r.react(context.Background(), Event{
		Type:     EvtThreadRuntimeModeSet,
		ThreadID: "ssh:sc-1",
		Payload:  mustJSON(RuntimeModeSetPayload{Mode: provider.ModeFullAccess}),
	}); err != nil {
		t.Fatalf("react: %v", err)
	}
}

// A malformed payload is an error, not a silent no-op: the mode the operator
// picked never reached the gate, and a card that should have been released is
// still up.
func TestReactorReportsAnUndecodableRuntimeModePayload(t *testing.T) {
	b := &releasingBroker{}
	r := &Reactor{Broker: b}

	err := r.react(context.Background(), Event{
		Type:     EvtThreadRuntimeModeSet,
		ThreadID: "ssh:sc-1",
		Payload:  []byte("{"),
	})
	if err == nil {
		t.Fatal("want an error for an undecodable payload")
	}
	if len(b.recorded()) != 0 {
		t.Fatal("nothing may be released off a payload that did not decode")
	}
}

// Changing the permission mode on an IDLE thread is ordinary — there is no
// live CLI to tell, and every turn carries the mode to the provider anyway
// (SendTurn's Mode: t.Mode). Reporting it as a failure surfaced
// "⚠️ provider: thread … is not bound to an instance" to the operator for a
// setting that had in fact taken effect.
func TestReactorAcceptsAModeChangeOnAThreadWithNoLiveSession(t *testing.T) {
	r := &Reactor{
		Broker: approval.NoopBroker{},
		Provider: &provider.Service{
			Dir:      NewThreadDirectory(),
			Registry: provider.NewRegistry(),
		},
	}

	for _, ev := range []Event{
		{Type: EvtThreadRuntimeModeSet, ThreadID: "w-idle",
			Payload: mustJSON(RuntimeModeSetPayload{Mode: provider.ModeFullAccess})},
		{Type: EvtThreadInteractionModeSet, ThreadID: "w-idle",
			Payload: mustJSON(InteractionModeSetPayload{Mode: provider.InteractionDefault})},
	} {
		if err := r.react(context.Background(), ev); err != nil {
			t.Fatalf("%s on an unbound thread: %v", ev.Type, err)
		}
	}
}
