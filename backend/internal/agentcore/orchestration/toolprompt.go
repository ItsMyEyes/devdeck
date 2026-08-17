package orchestration

import (
	"context"
	"fmt"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
)

// resolveInjectTimeout bounds the RequestResolved injection Ask always
// attempts on its way out. It runs on a context independent of the caller's
// (see Ask), so it needs its own ceiling rather than blocking forever.
const resolveInjectTimeout = 5 * time.Second

// ToolApprovalPrompter satisfies service.ApprovalPrompter (see
// backend/internal/service/ssh_tool.go) by driving the exact same event path
// a provider's own approval request takes. Design spec §4.4: an approval
// card raised by DevDeck's tool layer must be indistinguishable, on the wire
// and in the UI, from one a provider raised — which is why Ask injects a
// synthetic event.Event through Ingestion instead of dispatching commands by
// hand. Ingestion.handle's existing event.RequestOpened case does the status
// bookkeeping (CmdThreadActivityAppend, then CmdThreadSessionSet with
// pendingRequestAdd) for free, and it can never drift from the provider
// path because it IS the provider path.
type ToolApprovalPrompter struct {
	Ingestion *Ingestion
	Gate      *approval.Gate
}

// Ask opens an approval card on threadID (event.RequestOpened), blocks on
// Gate.Await for the user's decision, and closes the card
// (event.RequestResolved) before returning — on every exit path, including
// errors. An orphaned card is a thread the user can never unstick, so the
// resolve injection uses a context independent of ctx: ctx may be exactly
// what just failed (timed out or was cancelled), and the resolution still
// has to land.
func (p *ToolApprovalPrompter) Ask(ctx context.Context, threadID, requestID string, rt event.RequestType, detail string) (event.Decision, error) {
	openErr := p.Ingestion.Inject(ctx, event.Event{
		Type:      event.RequestOpened,
		ThreadID:  threadID,
		RequestID: requestID,
		Payload: &event.RequestOpenedPayload{
			RequestType: rt,
			Detail:      detail,
			Options: []event.Decision{
				event.DecisionAccept,
				event.DecisionAcceptForSession,
				event.DecisionDecline,
			},
		},
	})
	if openErr != nil {
		// The card never reached the thread timeline, so there is nothing
		// pending on the Gate and nothing to resolve — resolving here would
		// close a card the user never saw open.
		return event.DecisionDecline, fmt.Errorf("tool approval: open request: %w", openErr)
	}

	decision, awaitErr := p.Gate.Await(ctx, threadID, requestID)
	if awaitErr != nil {
		// ctx ended, or the thread was cancelled out from under the caller
		// (approval.Gate.CancelThread already delivers DecisionDecline for
		// that case, but a plain ctx timeout does not go through Resolve at
		// all). Decline is the safe default either way: the caller
		// (service.SSHToolService) must never run a gated command against an
		// unresolved wait.
		decision = event.DecisionDecline
	}

	resolveCtx, cancel := context.WithTimeout(context.Background(), resolveInjectTimeout)
	defer cancel()
	resolveErr := p.Ingestion.Inject(resolveCtx, event.Event{
		Type:      event.RequestResolved,
		ThreadID:  threadID,
		RequestID: requestID,
		Payload: &event.RequestResolvedPayload{
			RequestType: rt,
			Decision:    decision,
		},
	})

	switch {
	case awaitErr != nil:
		return decision, awaitErr
	case resolveErr != nil:
		return decision, fmt.Errorf("tool approval: resolve request: %w", resolveErr)
	default:
		return decision, nil
	}
}

// SessionAccepted reports whether threadID has already answered a mutating
// request with event.DecisionAcceptForSession this session (see
// approval.Gate.SessionAccepted).
func (p *ToolApprovalPrompter) SessionAccepted(threadID string) bool {
	return p.Gate.SessionAccepted(threadID)
}
