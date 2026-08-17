package orchestration

import (
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/domain"
)

// stubAttachmentReader is a fake AttachmentReader. byID supplies the bytes
// returned for a known id; err, when set, is returned for every id instead —
// enough to drive both the success and failure paths without a real store.
type stubAttachmentReader struct {
	byID map[string][]byte
	err  error
}

func (s *stubAttachmentReader) AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error) {
	if s.err != nil {
		return domain.AgentAttachment{}, nil, s.err
	}
	data, ok := s.byID[id]
	if !ok {
		return domain.AgentAttachment{}, nil, errors.New("stub: unknown attachment id")
	}
	return domain.AgentAttachment{ID: id}, data, nil
}

var _ AttachmentReader = (*stubAttachmentReader)(nil)

// TestReact_TurnStart_LoadsAttachmentBytes proves the reactor resolves an
// attachment id into bytes before handing the turn to the provider — the
// command itself only ever carries the id (T3's 4KB wire-size regression
// depends on this), so if this load never happened the provider would see an
// attachment with empty Data and silently send text with no image.
func TestReact_TurnStart_LoadsAttachmentBytes(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	wantBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef}
	h.reactor.Attachments = &stubAttachmentReader{byID: map[string][]byte{"a-1": wantBytes}}

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:        "look at this",
		Attachments: []provider.Attachment{{ID: "a-1", Kind: "image", MIME: "image/png", Name: "x.png"}},
	}))

	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	calls := h.adapter.turnCalls()
	if len(calls[0].Attachments) != 1 {
		t.Fatalf("SendTurn attachments = %+v, want exactly one", calls[0].Attachments)
	}
	if got := calls[0].Attachments[0].Data; string(got) != string(wantBytes) {
		t.Fatalf("SendTurn attachment data = %v, want %v", got, wantBytes)
	}
}

// TestReact_TurnStart_AttachmentLoadFailure_ReportsError proves a failed load
// never reaches the provider at all — the point of loading eagerly, before
// SendTurn, is that a bad id fails clean instead of the provider silently
// carrying an empty-Data attachment. The failure must surface through the
// same reportError path every other reactor failure uses, not a new one.
func TestReact_TurnStart_AttachmentLoadFailure_ReportsError(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.reactor.Attachments = &stubAttachmentReader{err: errors.New("boom: attachment store unreachable")}

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{
		Text:        "look at this",
		Attachments: []provider.Attachment{{ID: "missing", Kind: "image", MIME: "image/png", Name: "x.png"}},
	}))

	waitFor(t, func() bool { return countErrorEntries(h.store.All()) == 1 })

	// Give the reactor time to have called SendTurn if it were ever going to —
	// it must not have.
	waitFor(t, func() bool { return threadStatus(t, h, "w-abc") == ThreadIdle })
	if got := len(h.adapter.turnCalls()); got != 0 {
		t.Fatalf("SendTurn called %d times, want 0 — a failed attachment load must short-circuit before the provider call", got)
	}
}

// TestReact_TurnStart_NoAttachmentReader_SkipsLoading proves Reactor.Attachments
// left at its zero value (nil) is not a crash and not a behavior change for a
// turn that carries no attachments — this is what keeps every pre-existing
// bare Reactor{} literal in workers_test.go/workers_reactor_test.go compiling
// and passing unmodified.
func TestReact_TurnStart_NoAttachmentReader_SkipsLoading(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()
	// h.reactor.Attachments is left nil — newReactorHarness never sets it.

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")

	h.dispatch(t, "w-abc", CmdThreadTurnStart, mustRaw(t, TurnStartPayload{Text: "no attachments here"}))

	waitFor(t, func() bool { return len(h.adapter.turnCalls()) == 1 })
	if got := h.adapter.turnCalls()[0].ThreadID; got != "w-abc" {
		t.Fatalf("SendTurn threadID = %q, want w-abc", got)
	}
}
