package orchestration

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/domain"
)

// Two workers connect the engine to the provider, and their directions are
// OPPOSITE. Keeping them separate is what prevents a cycle: if one component
// both called the provider AND consumed its output, you would end up writing
// a deadlock.
//
//	Ingestion : provider stream  --> command  --> engine   (inbound)
//	Reactor   : engine event     --> provider call         (outbound)

// ---------------------------------------------------------------------------
// Ingestion: canonical event -> command
// ---------------------------------------------------------------------------

// Ingestion consumes Adapter.Events() and translates them into internal
// commands. This is the only path by which agent output enters state.
//
// t3code equivalent: ProviderRuntimeIngestion.ts
type Ingestion struct {
	Engine *Engine
	Broker approval.Broker
	NewID  func() string

	// Delivery controls buffering of assistant text. See the note below.
	Delivery DeliveryPolicy

	// Memory retains the assistant's reply text into persistent agent memory
	// when a turn ends. Zero value is a no-op — see MemoryHooks' doc comment.
	Memory MemoryHooks

	mu      sync.Mutex
	buffers map[string]*assistantBuffer // key: threadID|turnID|itemID

	// memoryText accumulates one turn's assistant text per thread, independent
	// of buffers above: buffers are flushed (and their keys deleted) as soon
	// as a delivery boundary is hit, but retain needs the FULL reply, so it
	// keeps its own copy alive until TurnCompleted/TurnAborted. Keyed by
	// threadID alone — a thread runs one turn at a time.
	memoryText map[string]*strings.Builder

	// signals tracks whether the in-flight turn has said ANYTHING the operator
	// can see. See turnSignal and the TurnCompleted case for what it is for.
	// Keyed by threadID alone, for the same reason memoryText is.
	signals map[string]*turnSignal
}

// turnSignal is the bookkeeping behind "a turn must never end silently".
//
// A turn can produce nothing for many reasons — a model refusal with no
// fallback, a CLI that exits mid-turn, a provider shape DevDeck has never
// seen — and every one of them used to look identical from the client's
// seat: `status: running` followed by `status: idle`, an empty transcript,
// and no way to tell a refusal from a crash from a bug in DevDeck. The
// operator's only recourse was to retype the message and watch it happen
// again.
//
// This is deliberately provider-AGNOSTIC. The claude parser now reports its
// own reasons (see parse.go's parseSystem/parseResult), but that only covers
// the shapes that parser knows; codex, opencode and pi reach this same code
// path, and so does the next CLI release with a failure mode nobody has seen
// yet. Anything that slips past every provider-specific case still ends the
// turn here, and here it is caught.
type turnSignal struct {
	// produced: the turn emitted something renderable — assistant text, a tool
	// call, an approval card, a proposed plan.
	produced bool
	// reported: a reason has ALREADY reached the transcript (a runtime error or
	// warning, or a denied tool), so the backstop below must stay quiet rather
	// than appending a second, vaguer notice underneath a specific one.
	reported bool
}

// DeliveryPolicy: buffered mode accumulates deltas instead of forwarding
// them one by one. t3code uses this for mobile clients — 500 events/sec will
// kill battery life and the render loop.
//
// What matters: the buffer is NOT held until the turn completes. It is
// flushed when
//  1. it exceeds MaxChars (t3code: 24_000), and
//  2. an interaction boundary is hit — the moment an approval/input request
//     opens.
//
// The second trigger is crucial. If the agent asks "may I delete this
// file?", the user needs to be able to read the reasoning that preceded it.
// Without a flush here, the prompt appears with no context at all.
type DeliveryPolicy struct {
	Buffered bool
	MaxChars int
}

type assistantBuffer struct {
	threadID string
	turnID   string
	itemID   string
	text     []byte
	seq      uint64
}

func NewIngestion(e *Engine, b approval.Broker, newID func() string) *Ingestion {
	return &Ingestion{
		Engine: e, Broker: b, NewID: newID,
		Delivery: DeliveryPolicy{Buffered: false, MaxChars: 24_000},
		buffers:  make(map[string]*assistantBuffer),
	}
}

// Consume runs the loop for a single adapter. Run one goroutine per provider
// instance.
func (in *Ingestion) Consume(ctx context.Context, a provider.Adapter) {
	events := a.Events()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				// Channel closed = the adapter died. Cancel every pending
				// approval, or the UI will show a ghost prompt forever.
				log.Printf("agentcore: adapter event channel closed, instance=%s", a.InstanceID())
				return
			}
			if err := in.handle(ctx, ev); err != nil {
				log.Printf("agentcore: ingest failed, type=%s err=%v", ev.Type, err)
			}
		}
	}
}

// Inject delivers a synthetic event.Event through the same path Consume
// feeds real adapter events through. ToolApprovalPrompter (sshthread.go,
// toolprompt.go) uses this to raise and resolve approval cards that
// originate in DevDeck's own tool layer rather than from a provider, so the
// resulting status bookkeeping is byte-for-byte what a provider event
// produces and can never drift from that path.
func (in *Ingestion) Inject(ctx context.Context, ev event.Event) error {
	return in.handle(ctx, ev)
}

func (in *Ingestion) handle(ctx context.Context, ev event.Event) error {
	in.noteSignal(ev)

	switch ev.Type {

	case event.ContentDelta:
		p, ok := ev.Payload.(*event.ContentDeltaPayload)
		if !ok {
			return nil
		}
		if in.Memory.Retain != nil && p.Stream == event.StreamText {
			in.accumulateMemoryText(ev.ThreadID, p.Text)
		}
		if in.Delivery.Buffered && p.Stream == event.StreamText {
			return in.appendBuffered(ctx, ev, p)
		}
		return in.emitDelta(ctx, ev, p.Text, p.Stream, p.Sequence)

	case event.RequestResolved, event.UserInputResolved:
		// A request the user never answered: it timed out, or the thread was
		// interrupted and the gate declined it on the operator's behalf (see
		// ToolApprovalPrompter.Ask, which injects this on both paths). The
		// clicked path never comes through here — it arrives as
		// CmdThreadApprovalRespond and clears itself.
		//
		// Both halves matter. The activity keeps the transcript honest about
		// how the card closed; the session-set is what actually retires the id
		// from Thread.PendingRequests. Without the second one the thread never
		// leaves `waiting` again, because engine.go only returns it to
		// `running` when that set empties — and the operator is left with a
		// composer that refuses to send and no visible reason why.
		if err := in.dispatch(ctx, Command{
			Type:     CmdThreadActivityAppend,
			ThreadID: ev.ThreadID,
			Payload:  mustJSON(ev),
		}); err != nil {
			return err
		}
		if ev.RequestID == "" {
			return nil
		}
		return in.dispatch(ctx, Command{
			Type:     CmdThreadSessionSet,
			ThreadID: ev.ThreadID,
			Payload:  mustJSON(map[string]any{"pendingRequestRemove": ev.RequestID}),
		})

	case event.RequestOpened, event.UserInputRequested:
		// Three steps, and the order is the whole point.
		//
		// Flush first, so the reasoning that led to the question is already on
		// screen when the question appears — a prompt with no context above it
		// is unanswerable.
		if err := in.flushThread(ctx, ev.ThreadID); err != nil {
			return err
		}
		if ev.Type == event.RequestOpened {
			in.Broker.Open(ev.ThreadID, ev.RequestID)
		}
		// Then the event itself. Without this the request's PAYLOAD — the
		// questions, the tool and its arguments — reached nobody: only the id
		// travelled, on the session-set below, so a waiting thread arrived at
		// the client indistinguishable from a running one and no panel had
		// anything to render.
		if err := in.dispatch(ctx, Command{
			Type:     CmdThreadActivityAppend,
			ThreadID: ev.ThreadID,
			Payload:  mustJSON(ev),
		}); err != nil {
			return err
		}
		// Status last. A client that paints its panel on status === waiting
		// must never find that panel empty for a frame.
		return in.dispatch(ctx, Command{
			Type:     CmdThreadSessionSet,
			ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{
				"status":            string(ThreadWaiting),
				"pendingRequestAdd": ev.RequestID,
			}),
		})

	case event.SessionStarted:
		p, _ := ev.Payload.(*event.SessionStartedPayload)
		payload := map[string]any{"status": string(ThreadRunning)}
		if p != nil && len(p.Resume) > 0 {
			// Store the resume cursor as-is. Never interpret it — its shape
			// differs per provider and changes between versions.
			payload["resumeCursor"] = p.Resume
		}
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID, Payload: mustJSON(payload),
		})

	case event.TurnCompleted, event.TurnAborted:
		if err := in.flushThread(ctx, ev.ThreadID); err != nil {
			return err
		}
		// Report BEFORE the status write below, not after: the session-set is
		// what settles the thread to idle, and a client that stops rendering a
		// turn at that point would never show a reason appended behind it.
		if err := in.reportSilentTurn(ctx, ev); err != nil {
			return err
		}
		// Whatever the assistant said this turn, even a partial reply on
		// TurnAborted — a memory of "started explaining X, then got
		// interrupted" is still worth more than nothing. takeMemoryText is a
		// no-op read on an unset key when no ContentDelta ever accumulated
		// (Memory.Retain was nil throughout, or the turn produced no text).
		in.Memory.retain(ctx, ev.ThreadID, "assistant", in.takeMemoryText(ev.ThreadID))
		payload := map[string]any{"status": string(ThreadIdle)}
		// The context window's actual occupancy after this turn — not a sum
		// across turns, which would double-count history that is already
		// folded into every request's own input/cache-read/cache-creation
		// counts. This is what the composer's context-window indicator reads
		// (Thread.ContextTokens); the CLI reports no "max" alongside it, so the
		// denominator the UI divides by is whatever context-window size the
		// user has selected on their end, not anything from this payload.
		if p, ok := ev.Payload.(*event.TurnCompletedPayload); ok && p.Usage != nil {
			payload["contextTokens"] = p.Usage.InputTokens + p.Usage.CacheReadTokens + p.Usage.CacheCreationTokens
			// What THIS turn cost, alongside the running occupancy above. The
			// two answer different questions and neither derives from the
			// other: contextTokens is a level (and can fall when history is
			// compacted), this is a flow. The transcript stamps each turn with
			// it, so `turnTokens` is a sum the UI can show as-is and
			// `turnOutputTokens` is the generated half, which is the only one
			// a tokens-per-second rate may be computed from.
			payload["turnTokens"] = p.Usage.InputTokens + p.Usage.OutputTokens +
				p.Usage.CacheReadTokens + p.Usage.CacheCreationTokens
			payload["turnOutputTokens"] = p.Usage.OutputTokens
		}
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(payload),
		})

	case event.SessionExited:
		// Session died: clean up pending approvals, don't wait for a timeout.
		in.Broker.CancelThread(ev.ThreadID)
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{"status": string(ThreadStopped)}),
		})

	case event.TurnProposedCompleted:
		// Puts the captured plan "on the table" (Thread.ProposedPlan). No
		// defensive idle-dispatch here, unlike RequestOpened/
		// UserInputRequested above: T1's live capture proved denying
		// ExitPlanMode's control_request still lets the CLI settle the turn
		// to a terminal `result` on its own (capture/README.md "Open
		// question 1") — the normal TurnCompleted/TurnAborted case above
		// already closes the thread out, so adding a second idle-dispatch
		// here would just be a redundant write.
		p, ok := ev.Payload.(*event.ProposedPlanPayload)
		if !ok {
			return nil
		}
		return in.dispatch(ctx, Command{
			Type: CmdThreadPlanPropose, ThreadID: ev.ThreadID,
			Payload: mustJSON(PlanProposePayload{
				PlanMarkdown: p.PlanMarkdown,
				PlanFilePath: p.PlanFilePath,
				ToolUseID:    p.ToolUseID,
			}),
		})

	default:
		// Everything else becomes generic activity. Better to store an
		// unrecognized event as activity than to drop it — you will need it
		// when debugging a new provider.
		return in.dispatch(ctx, Command{
			Type: CmdThreadActivityAppend, ThreadID: ev.ThreadID,
			Payload: mustJSON(ev),
		})
	}
}

// noteSignal records what the in-flight turn has shown the operator so far.
// See turnSignal for why this exists at all.
//
// Called for EVERY event, including the ones Inject feeds in from DevDeck's
// own tool layer (sshthread.go's ToolApprovalPrompter) — an SSH chat turn
// whose whole visible output is an approval card has very much said
// something, and must not be reported as silent.
func (in *Ingestion) noteSignal(ev event.Event) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.signals == nil {
		in.signals = make(map[string]*turnSignal)
	}
	sig := in.signals[ev.ThreadID]
	if sig == nil {
		sig = &turnSignal{}
		in.signals[ev.ThreadID] = sig
	}

	switch ev.Type {
	case event.TurnStarted:
		// A fresh turn starts from silence. Reset rather than delete so a
		// provider that never emits TurnStarted still gets a zero value below.
		*sig = turnSignal{}

	case event.RuntimeError, event.RuntimeWarning, event.ToolDenied:
		// A reason reached the transcript. Also counts as produced: the turn is
		// no longer blank on screen.
		sig.reported = true
		sig.produced = true

	case event.ContentDelta:
		// Empty deltas do not count — emitDelta drops those, so a turn made
		// only of them still renders as nothing at all.
		if p, ok := ev.Payload.(*event.ContentDeltaPayload); ok && p.Text != "" {
			sig.produced = true
		}

	case event.ItemStarted, event.ItemCompleted, event.RequestOpened,
		event.UserInputRequested, event.TurnProposedCompleted:
		sig.produced = true
	}
}

// takeSignal returns and clears a thread's turn bookkeeping.
func (in *Ingestion) takeSignal(threadID string) turnSignal {
	in.mu.Lock()
	defer in.mu.Unlock()
	sig, ok := in.signals[threadID]
	if !ok {
		return turnSignal{}
	}
	delete(in.signals, threadID)
	return *sig
}

// reportSilentTurn appends the reason a turn ended, whenever the turn would
// otherwise close with nothing to show for it. Two cases, in priority order:
//
//  1. The provider reported the turn FAILED. Before this, that verdict lived
//     only in TurnCompletedPayload.Status, which this file read and discarded
//     — a failed turn and a successful one produced byte-identical output on
//     the wire (one `thread.session-set` with status idle), so the client had
//     nothing to render and no way to know there was anything to render.
//  2. The turn completed "successfully" but said nothing at all: no text, no
//     tool call, no approval, and no reason already reported. That is the
//     shape a model refusal with zero output tokens takes, and the shape any
//     future provider bug will take too.
//
// TurnAborted is deliberately exempt from case 2: an interrupt the operator
// pressed themselves legitimately produces nothing, and telling them their
// own Stop button produced no output is noise, not information.
func (in *Ingestion) reportSilentTurn(ctx context.Context, ev event.Event) error {
	sig := in.takeSignal(ev.ThreadID)

	failed := false
	if p, ok := ev.Payload.(*event.TurnCompletedPayload); ok && p.Status == "failed" {
		failed = true
	}

	switch {
	case failed && !sig.reported:
		return in.appendNotice(ctx, ev, event.RuntimeError,
			"The agent ended this turn with an error but reported no reason. "+
				"Check the agent CLI's own output for details.")
	case ev.Type == event.TurnCompleted && !sig.produced && !sig.reported:
		return in.appendNotice(ctx, ev, event.RuntimeWarning,
			"This turn finished without producing any output. The agent may have "+
				"declined the request or stopped early; try rephrasing, or switch "+
				"models if it keeps happening.")
	}
	return nil
}

// appendNotice forwards a synthetic canonical event down the SAME path
// handle's default case forwards a real one, so the client renders it with
// the branches it already has (eventReducer.ts's `runtime.error` ->
// error row, `runtime.warning` -> notice row) and no new wire shape exists to
// keep in sync.
func (in *Ingestion) appendNotice(ctx context.Context, ev event.Event, typ event.Type, message string) error {
	notice := event.Event{
		Type:       typ,
		Provider:   ev.Provider,
		InstanceID: ev.InstanceID,
		ThreadID:   ev.ThreadID,
		TurnID:     ev.TurnID,
		CreatedAt:  ev.CreatedAt,
	}
	if typ == event.RuntimeError {
		notice.Payload = &event.ErrorPayload{Message: message}
	} else {
		notice.Payload = &event.WarningPayload{Message: message}
	}
	return in.dispatch(ctx, Command{
		Type:     CmdThreadActivityAppend,
		ThreadID: ev.ThreadID,
		Payload:  mustJSON(notice),
	})
}

// accumulateMemoryText appends to a thread's running reply text, for retain
// at TurnCompleted/TurnAborted. Independent of the buffers map used for
// client delivery — see memoryText's doc comment on the Ingestion struct.
func (in *Ingestion) accumulateMemoryText(threadID, text string) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.memoryText == nil {
		in.memoryText = make(map[string]*strings.Builder)
	}
	b := in.memoryText[threadID]
	if b == nil {
		b = &strings.Builder{}
		in.memoryText[threadID] = b
	}
	b.WriteString(text)
}

// takeMemoryText returns and clears a thread's accumulated reply text.
func (in *Ingestion) takeMemoryText(threadID string) string {
	in.mu.Lock()
	defer in.mu.Unlock()
	b, ok := in.memoryText[threadID]
	if !ok {
		return ""
	}
	delete(in.memoryText, threadID)
	return b.String()
}

func (in *Ingestion) appendBuffered(ctx context.Context, ev event.Event, p *event.ContentDeltaPayload) error {
	key := ev.ThreadID + "|" + ev.TurnID + "|" + ev.ItemID
	in.mu.Lock()
	buf := in.buffers[key]
	if buf == nil {
		buf = &assistantBuffer{threadID: ev.ThreadID, turnID: ev.TurnID, itemID: ev.ItemID}
		in.buffers[key] = buf
	}
	overflow := len(buf.text)+len(p.Text) > in.Delivery.MaxChars
	buf.text = append(buf.text, p.Text...)
	buf.seq = p.Sequence
	var spill []byte
	if overflow {
		spill = buf.text
		delete(in.buffers, key)
	}
	in.mu.Unlock()

	if spill == nil {
		return nil
	}
	// Spill the entire accumulation as ONE delta. Not just the part that
	// exceeded the limit — if you send only that part, the client loses the
	// beginning of the message.
	return in.emitDelta(ctx, ev, string(spill), event.StreamText, buf.seq)
}

func (in *Ingestion) flushThread(ctx context.Context, threadID string) error {
	in.mu.Lock()
	var pending []*assistantBuffer
	for k, b := range in.buffers {
		if b.threadID == threadID {
			pending = append(pending, b)
			delete(in.buffers, k)
		}
	}
	in.mu.Unlock()

	for _, b := range pending {
		ev := event.Event{ThreadID: b.threadID, TurnID: b.turnID, ItemID: b.itemID}
		if err := in.emitDelta(ctx, ev, string(b.text), event.StreamText, b.seq); err != nil {
			return err
		}
	}
	return nil
}

func (in *Ingestion) emitDelta(ctx context.Context, ev event.Event, text string, s event.StreamKind, seq uint64) error {
	if text == "" {
		return nil
	}
	return in.dispatch(ctx, Command{
		Type:     CmdThreadAssistantDelta,
		ThreadID: ev.ThreadID,
		Payload: mustJSON(AssistantDeltaPayload{
			TurnID: ev.TurnID, ItemID: ev.ItemID, Stream: s, Text: text, Sequence: seq,
		}),
	})
}

func (in *Ingestion) dispatch(ctx context.Context, cmd Command) error {
	cmd.CommandID = in.NewID()
	_, err := in.Engine.Dispatch(ctx, cmd)
	return err
}

// ---------------------------------------------------------------------------
// Boot reconciliation: orphaned in-flight threads -> idle
// ---------------------------------------------------------------------------

// ReconcileOrphanedThreads closes out every thread the just-replayed event
// log left non-terminal (ThreadRunning or ThreadWaiting).
//
// Every adapter — and the real process behind it — lives only as long as the
// server that started it: the provider registry and threadDirectory are
// rebuilt empty on every boot (see main.go's comment on agentLog). A turn
// that was in flight, or an approval that was still pending, at the moment
// the previous process exited therefore has nothing left that can ever
// resolve it. Nobody will send the SessionStarted/TurnCompleted/
// SessionExited event that normally closes a turn out via the cases above —
// that event came from the now-dead subprocess. Left alone, Status stays
// exactly what it was at shutdown forever, because every future boot replays
// the same unresolved event again. On screen this is a chat pane stuck
// showing "Running", with a "Working for Ns" counter climbing from whenever
// the turn was interrupted — hours or days ago — with the agent doing
// nothing and never going to.
//
// This dispatches the same CmdThreadSessionSet a real session exit would
// (SessionExited, above) through the full engine pipeline, so the fix is a
// durably persisted event, not a one-off patch to the freshly-replayed
// in-memory state — it has to survive the NEXT replay too, or the bug just
// comes back on the following restart. clearPending empties out any approval
// the dead process can no longer honor, the same way SessionExited does via
// Broker.CancelThread — there is no live broker request to cancel here
// (nothing asked for one across a restart), so this clears the engine's own
// PendingRequests bookkeeping directly instead.
//
// Call once, right after Engine.Run starts. Partial failure does not abort
// startup — a thread this can't fix stays exactly as broken as it already
// was, which is what "best-effort cleanup" means; the caller decides whether
// to log it.
func ReconcileOrphanedThreads(ctx context.Context, e *Engine, newID func() string) (int, error) {
	reconciled := 0
	for id, t := range e.State().Threads {
		if t.Deleted || (t.Status != ThreadRunning && t.Status != ThreadWaiting) {
			continue
		}
		if _, err := e.Dispatch(ctx, Command{
			CommandID: newID(),
			Type:      CmdThreadSessionSet,
			ThreadID:  id,
			Payload: mustJSON(map[string]any{
				"status":       string(ThreadIdle),
				"clearPending": true,
			}),
		}); err != nil {
			return reconciled, fmt.Errorf("reconcile thread %s: %w", id, err)
		}
		reconciled++
	}
	return reconciled, nil
}

// ---------------------------------------------------------------------------
// Reactor: engine event -> provider call
// ---------------------------------------------------------------------------

// AttachmentReader is the narrow slice of persistence the Reactor needs to
// resolve an attachment id into bytes before handing it to the provider —
// declared here, not imported from port, mirroring portstore.go's
// EventStore. domain.AgentAttachment matches store.Store's method exactly,
// so the concrete store satisfies this with no adapter.
type AttachmentReader interface {
	AgentAttachmentData(id string) (domain.AgentAttachment, []byte, error)
}

// pendingReleaser is the half of approval.Gate the Reactor needs for
// EvtThreadRuntimeModeSet, declared here as a narrow optional interface rather
// than added to approval.Broker.
//
// Broker is the contract every approval transport satisfies, including the
// provider-driven one where DevDeck writes an answer to a CLI's stdin and no
// goroutine of ours is parked on anything. Releasing a pending wait is
// meaningless there, so making it a Broker method would oblige every
// implementation to carry a stub for a capability only the blocking gate has.
type pendingReleaser interface {
	// ReleasePending accepts every request open on threadID that mode would
	// not have gated, returning the ids released.
	ReleasePending(threadID string, mode provider.RuntimeMode) []string
}

// Reactor listens for committed intent events and performs the actual
// provider call. It runs AFTER commit, so the user's intent is already
// durably recorded even if the provider call itself fails — which is what
// makes retrying safe.
//
// t3code equivalent: ProviderCommandReactor.ts
type Reactor struct {
	Engine   *Engine
	Provider *provider.Service
	Broker   approval.Broker

	// Attachments resolves an attachment id (all a TurnStartPayload ever
	// carries over the wire — see provider.Attachment's `json:"-"` Data tag)
	// into its bytes, right before the turn reaches the provider. Left nil
	// (the zero value) is a valid, tested configuration: a turn with no
	// attachments never touches this field, which is what keeps every
	// pre-existing bare Reactor{} literal in this package's own tests
	// compiling and passing unmodified.
	Attachments AttachmentReader

	// Memory recalls persistent-memory context and prepends it to a turn's
	// text before it reaches the provider. Zero value is a no-op — see
	// MemoryHooks' doc comment.
	Memory MemoryHooks

	// InstanceFor resolves a thread to the worktree's configured agent, its
	// cwd, and the instance that should run it. Injected so the Reactor stays
	// testable without a real worktree — main.go builds this from port.Store.
	InstanceFor func(threadID string) (provider.InstanceID, provider.SessionStartInput, error)

	// OnInstanceStarted fires exactly once per FRESHLY started instance, with
	// the adapter just created. main.go uses it to start the Ingestion loop
	// that drains Adapter.Events() back into the engine.
	//
	// Reactor and Ingestion are deliberately separate components running in
	// opposite directions, but only the Reactor ever learns that an adapter
	// was born — so this is the one place that can start its consumer. Without
	// it nothing reads Adapter.Events(): the 256-slot buffer fills and then
	// silently drops every delta and tool call, leaving a chat that echoes the
	// user's own message and never shows a reply.
	OnInstanceStarted func(ctx context.Context, a provider.Adapter)
}

// Start subscribes on the CALLER's goroutine, then runs the loop on a new
// one. Prefer this over `go r.Run(ctx)`.
//
// Engine.publish only delivers to subscribers that exist at publish time, so
// with `go r.Run(ctx)` every event committed before that goroutine happens to
// reach Subscribe is silently dropped — no error, no retry, the turn simply
// never reaches the provider. Subscribing before returning closes that window
// entirely.
func (r *Reactor) Start(ctx context.Context) {
	sub, unsub := r.Engine.Subscribe(256)
	go r.loop(ctx, sub, unsub)
}

// Run is Start's blocking form, kept for callers that own the goroutine. It
// carries the same startup window Start exists to remove: anything committed
// before this function body begins executing is missed.
func (r *Reactor) Run(ctx context.Context) {
	sub, unsub := r.Engine.Subscribe(256)
	r.loop(ctx, sub, unsub)
}

func (r *Reactor) loop(ctx context.Context, sub <-chan []Event, unsub func()) {
	defer unsub()

	for {
		select {
		case <-ctx.Done():
			return
		case batch, ok := <-sub:
			if !ok {
				return
			}
			for _, e := range batch {
				if !IntentEvents[e.Type] {
					continue
				}
				if err := r.react(ctx, e); err != nil {
					log.Printf("agentcore: reactor failed, event=%s thread=%s err=%v", e.Type, e.ThreadID, err)
					// Dispatch the failure back through the engine so the
					// user sees it, instead of it only landing in the log.
					r.reportError(ctx, e, err)
				}
			}
		}
	}
}

// reportError makes a failed provider call visible to the user by appending
// it to the thread's activity log. The CommandID is derived from the intent
// event's EventID (already a unique, decider-assigned id) rather than a
// freshly minted one — Reactor deliberately carries no NewID of its own, so
// this doubles as idempotency: if the same intent event were ever reacted to
// twice, the user sees one error entry, not a duplicate. Errors dispatching
// THIS command are only logged — there is nowhere else left to report them.
func (r *Reactor) reportError(ctx context.Context, e Event, cause error) {
	cmd := Command{
		CommandID: "ac-reactor-err-" + e.EventID,
		Type:      CmdThreadActivityAppend,
		ThreadID:  e.ThreadID,
		Payload: mustJSON(map[string]any{
			"kind":    "runtime.error",
			"message": cause.Error(),
		}),
	}
	if _, err := r.Engine.Dispatch(ctx, cmd); err != nil {
		log.Printf("agentcore: failed to report reactor error to thread=%s err=%v", e.ThreadID, err)
	}

	// Settle the thread as well as reporting the failure. A reactor error is a
	// side effect that did NOT happen — the CLI never spawned, the turn was
	// never delivered — so nothing is coming to move the thread off
	// ThreadRunning later. Reporting the error alone left the transcript
	// showing "Working for 1877s" under a turn that had already failed, with
	// the composer stuck on Stop and no way back.
	//
	// Separate command, and dispatched even if the append above failed: the
	// status is the half the user cannot work around.
	status := Command{
		CommandID: "ac-reactor-err-idle-" + e.EventID,
		Type:      CmdThreadSessionSet,
		ThreadID:  e.ThreadID,
		Payload:   mustJSON(map[string]any{"status": string(ThreadIdle)}),
	}
	if _, err := r.Engine.Dispatch(ctx, status); err != nil {
		log.Printf("agentcore: failed to settle thread=%s after reactor error err=%v", e.ThreadID, err)
	}
}

func (r *Reactor) react(ctx context.Context, e Event) error {
	switch e.Type {
	case EvtThreadCreated:
		// This is the first place a committed event triggers a long-running
		// side effect (spawning a CLI process). The commit already happened —
		// EvtThreadCreated is durable — so a failure here is a visible error
		// via reportError, never a lost thread.
		return r.ensureSession(ctx, e.ThreadID, "")

	case EvtThreadTurnStartRequested:
		var p TurnStartPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		st := r.Engine.State()
		t, ok := st.Thread(e.ThreadID)
		if !ok {
			return nil
		}
		// A turn cannot assume a session is already running, for two reasons:
		//
		//  1. ThreadDirectory is in-memory and Bind only ever happened on the
		//     one-time EvtThreadCreated. After a server restart that event is
		//     long since committed and never replays, so a thread that looks
		//     perfectly healthy — its log intact, its state rehydrated — has
		//     no adapter bound and every turn fails "not bound to an instance".
		//  2. The composer can now name an agent (ModelSelection.InstanceID).
		//     Switching agents mid-thread means binding and starting a session
		//     on the new one; the provider has no memory of the conversation
		//     either way, since each CLI owns its own session.
		//
		// ensureSession is a no-op when the thread is already on the requested
		// instance, so the common turn pays one map lookup.
		if err := r.ensureSession(ctx, e.ThreadID, p.Model.InstanceID); err != nil {
			return err
		}
		// The command payload only ever carries an attachment's id — Data is
		// `json:"-"` on provider.Attachment specifically so raw bytes never
		// enter the durable event log or the 1MB command-frame cap (T3's
		// regression test guards this). Load the real bytes here, the one
		// place they are needed, immediately before the provider call — a
		// failed load must return before SendTurn ever runs, not hand the
		// provider a silently-empty attachment.
		if r.Attachments != nil {
			for i := range p.Attachments {
				_, data, err := r.Attachments.AgentAttachmentData(p.Attachments[i].ID)
				if err != nil {
					return err
				}
				p.Attachments[i].Data = data
			}
		}
		// Recall happens here, not inside the provider adapter, so it is one
		// code path for every provider (claude/codex/opencode/pi) and the SSH
		// DevOps chat at once — see MemoryHooks' doc comment. sendText carries
		// the recalled block; the COMMITTED event (e.Payload, already durable)
		// and p.Text used for retain below both stay exactly what the user
		// typed, so the transcript never shows memory the user didn't write.
		sendText := p.Text
		if block := r.Memory.recall(ctx, e.ThreadID, p.Text); block != "" {
			sendText = block + "\n\n" + sendText
		}
		r.Memory.retain(ctx, e.ThreadID, "user", p.Text)
		_, err := r.Provider.SendTurn(ctx, provider.SendTurnInput{
			ThreadID:    e.ThreadID,
			TurnID:      e.EventID,
			Text:        sendText,
			Attachments: p.Attachments,
			Mode:        t.Mode,
			Interact:    t.Interact,
			Model:       p.Model,
		})
		return err

	case EvtThreadApprovalResponseRequested:
		var p ApprovalRespondPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		// Two paths, and both are needed:
		//  - Broker.Resolve unblocks the adapter goroutine that is holding
		//    the agent (for callback-style providers like Claude's
		//    canUseTool).
		//  - Provider.RespondToRequest sends a reply RPC (for JSON-RPC-style
		//    providers like Codex/ACP).
		// An adapter that doesn't use one of these is simply a no-op on it.
		if err := r.Broker.Resolve(p.RequestID, p.Decision); err != nil &&
			err != approval.ErrUnknownRequest {
			return err
		}
		// A "tool-" request id was raised by DevDeck's own tool layer (see
		// orchestration.ToolApprovalPrompter), not by a provider — there is
		// no provider-side request to answer, so calling RespondToRequest
		// for one could only fail or reply to whatever unrelated request
		// the provider itself has open. The Broker resolution above is the
		// whole answer for these.
		if strings.HasPrefix(p.RequestID, ToolRequestPrefix) {
			return nil
		}
		return r.Provider.RespondToRequest(ctx, e.ThreadID, p.RequestID, p.Decision)

	case EvtThreadUserInputResponseRequested:
		var p UserInputRespondPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		// No Broker.Resolve here, unlike the approval case above, because
		// there is no blocked goroutine to unblock: DevDeck drives the raw CLI
		// over the stdin/stdout control channel, not the TypeScript SDK's
		// canUseTool callback. The answer is a write, not a hand-off.
		//
		// Without this case the event fell through to `return nil`: the
		// pending flag cleared and the thread flipped waiting -> running, so
		// the UI looked answered while the agent stayed blocked forever.
		return r.Provider.RespondToUserInput(ctx, e.ThreadID, p.RequestID, p.Answers)

	case EvtThreadTurnInterruptRequested:
		st := r.Engine.State()
		t, ok := st.Thread(e.ThreadID)
		if !ok {
			return nil
		}
		// Cancel pending approvals FIRST. Otherwise the interrupt would wait
		// on a turn that is itself waiting on the user.
		r.Broker.CancelThread(e.ThreadID)
		interruptErr := r.Provider.InterruptTurn(ctx, e.ThreadID, t.CurrentTurn)

		// Settle the thread regardless of what the provider did with the
		// request. `InterruptTurn` is best-effort by contract — the claude
		// adapter returns nil both when it wrote the control_request AND when
		// it holds no session for this thread at all — so a thread whose
		// process has already died would otherwise stay ThreadRunning with
		// Stop as its only control, and Stop having no effect. Pressing Stop
		// has to be a way OUT of running, not a request that may be ignored.
		//
		// Safe when the provider is healthy: it answers with TurnAborted a
		// moment later, which sets the same status. Any output still in flight
		// keeps appending to the transcript either way.
		if _, err := r.Engine.Dispatch(ctx, Command{
			CommandID: "ac-interrupt-idle-" + e.EventID,
			Type:      CmdThreadSessionSet,
			ThreadID:  e.ThreadID,
			Payload:   mustJSON(map[string]any{"status": string(ThreadIdle)}),
		}); err != nil {
			log.Printf("agentcore: failed to settle thread=%s after interrupt err=%v", e.ThreadID, err)
		}
		return interruptErr

	case EvtThreadRuntimeModeSet:
		// The mirror of EvtThreadInteractionModeSet below, and it was missing
		// for the same reason: the event is in IntentEvents, so it reached this
		// switch, fell through to `return nil`, and only ever updated the read
		// model. That was almost enough — SSHToolService reads the thread's
		// mode fresh on every call, so the NEXT tool call already obeys a mode
		// change — but a call that is currently BLOCKED on an approval card has
		// already read it. The operator switches the thread to full access to
		// get past the prompt, and the prompt they were trying to dismiss keeps
		// waiting for them to answer it.
		//
		// Releasing is the gate's own decision, not this switch's: it holds the
		// class of each open request and re-runs the same permission matrix
		// SSHToolService used to open the card in the first place. So switching
		// to `auto` with a file write pending correctly releases nothing.
		var p RuntimeModeSetPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		if releaser, ok := r.Broker.(pendingReleaser); ok {
			for _, id := range releaser.ReleasePending(e.ThreadID, p.Mode) {
				log.Printf("agentcore: released approval request=%s thread=%s under mode=%s", id, e.ThreadID, p.Mode)
			}
		}
		// A Broker with no blocking waiters (the provider-driven path) has
		// nothing to release above: a provider enforces its own permission
		// mode and never parks a goroutine of ours on a card. Which is
		// exactly why the push below still has to happen regardless: releasing
		// DevDeck's own pending cards was never the same thing as changing
		// what the LIVE agent process itself decides to gate. Before this
		// existed, that push never happened at all — the mode change updated
		// Thread.Mode in the read model and released same-process approval
		// cards, but the running claude/codex/pi CLI kept enforcing whatever
		// --permission-mode/approvalPolicy it was launched with for the rest
		// of the session. An operator switching to auto or full access (or
		// back to approval-required) kept being asked exactly as before, no
		// matter what the Permission pill now said — see
		// provider.Adapter.SetRuntimeMode's doc comment.
		//
		// r.Provider may be nil in tests that construct a bare Reactor to
		// exercise the Broker path in isolation (see
		// workers_runtimemode_test.go) — production always wires one.
		if r.Provider == nil {
			return nil
		}
		id, ok := r.Provider.Dir.InstanceFor(e.ThreadID)
		if !ok {
			// No LIVE session to tell, which is the ordinary state of an idle
			// thread — and not a failure, because the mode is already
			// committed to thread state and every turn carries it to the
			// provider itself (SendTurn's Mode: t.Mode above). This case
			// exists only to reach a CLI that is running RIGHT NOW, so that
			// an operator switching mid-session stops being asked
			// immediately rather than from the next turn.
			//
			// It used to return an error, which reached the operator as
			// "⚠️ provider: thread … is not bound to an instance" — alarming,
			// and wrong: the setting they just changed had in fact taken
			// effect.
			return nil
		}
		a, err := r.Provider.Registry.Adapter(id)
		if err != nil {
			return err
		}
		return a.SetRuntimeMode(ctx, e.ThreadID, p.Mode)

	case EvtThreadInteractionModeSet:
		var p InteractionModeSetPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		// Resolved the same way EvtThreadSessionStopRequested resolves its
		// adapter below, not through r.Provider.Service — this is the exact
		// gap the spec's problem #2 names: before this case existed,
		// EvtThreadInteractionModeSet (already in IntentEvents) fell through
		// this switch to `return nil`, so flipping the composer's Plan pill
		// updated the read model but never reached the live CLI process.
		id, ok := r.Provider.Dir.InstanceFor(e.ThreadID)
		if !ok {
			// Same as the runtime mode above: nothing live to tell, and the
			// next turn carries Interact: t.Interact regardless.
			return nil
		}
		a, err := r.Provider.Registry.Adapter(id)
		if err != nil {
			return err
		}
		return a.SetInteractionMode(ctx, e.ThreadID, p.Mode)

	case EvtThreadSessionStopRequested:
		r.Broker.CancelThread(e.ThreadID)
		// Routed through r.Provider.Dir like every other case, instead of
		// reaching into Engine state for a separately-tracked InstanceID.
		// Two thread->instance lookup mechanisms in one switch is a latent
		// divergence: this one, Dir, is the one EvtThreadCreated actually
		// binds above.
		id, ok := r.Provider.Dir.InstanceFor(e.ThreadID)
		if !ok {
			return fmt.Errorf("provider: thread %s is not bound to an instance", e.ThreadID)
		}
		a, err := r.Provider.Registry.Adapter(id)
		if err != nil {
			return err
		}
		return a.StopSession(ctx, e.ThreadID)
	}
	return nil
}

// ensureSession makes a thread ready to receive a turn: the instance running,
// the thread bound to it, and a provider session started against it.
//
// `want` names the instance to use. Empty means "whatever this worktree is
// configured for", which is the only answer EvtThreadCreated has; a turn may
// instead pass an explicit instance, which is how the composer's agent picker
// switches a thread from one CLI to another.
//
// Idempotent by design — it is called on every turn. When the thread is
// already bound to `want` AND that instance's adapter is alive, it does
// nothing. The adapter check is not redundant with the binding: the directory
// is in-memory and the registry is too, but they are separate maps and an
// instance can die (or a restart can empty both) independently of what the
// directory remembers. Re-binding without a live adapter is exactly the
// "not bound to an instance" failure this exists to prevent.
func (r *Reactor) ensureSession(ctx context.Context, threadID string, want provider.InstanceID) error {
	id, sessionIn, err := r.InstanceFor(threadID)
	if err != nil {
		return err
	}
	if want != "" {
		id = want
	}

	if bound, ok := r.Provider.Dir.InstanceFor(threadID); ok && bound == id {
		if _, err := r.Provider.Registry.Adapter(id); err == nil {
			return nil
		}
	}

	if err := r.ensureInstanceStarted(ctx, id); err != nil {
		return err
	}
	// StartInstance -> Bind -> StartSession, in that order: the instance must
	// exist before anything is bound to it, and it must be bound before a
	// session is started against it.
	r.Provider.Dir.Bind(threadID, id)
	a, err := r.Provider.Registry.Adapter(id)
	if err != nil {
		return err
	}
	sessionIn.ThreadID = threadID
	if t, ok := r.Engine.State().Thread(threadID); ok {
		sessionIn.Mode = t.Mode
		sessionIn.Interact = t.Interact
	}
	_, err = a.StartSession(ctx, sessionIn)
	return err
}

// ensureInstanceStarted starts the instance if it is not already running.
// StartInstance is keyed by InstanceID and shared across threads — the
// Reactor's single-goroutine command loop means the check and the start are
// not racing each other, and the "already running" fallback below is a
// defensive backstop, not the primary guard.
func (r *Reactor) ensureInstanceStarted(ctx context.Context, id provider.InstanceID) error {
	if _, err := r.Provider.Registry.Adapter(id); err == nil {
		return nil
	}
	kind := instanceKind(id)
	if kind == "" {
		// An InstanceID like ":default" means the caller could not resolve an
		// agent — most often a worktree with an empty Agent field. Say that,
		// rather than "no driver registered for " with a blank where the name
		// should be, which is what this reported before.
		return fmt.Errorf("agentcore: no agent configured for this worktree (instance %q); set one on the worktree to use chat", id)
	}
	d, ok := r.Provider.Registry.Driver(kind)
	if !ok {
		return fmt.Errorf("agentcore: no driver registered for %q", kind)
	}
	cfg, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil {
		return err
	}
	a, err := r.Provider.Registry.StartInstance(ctx, kind, provider.InstanceSpec{
		InstanceID:  id,
		DisplayName: string(id),
		Config:      cfg,
		Enabled:     true,
	})
	if err != nil {
		if strings.Contains(err.Error(), "already running") {
			// Someone else started it; its consumer is already running too.
			return nil
		}
		return err
	}
	// Fresh instance — start draining its events. Exactly once per adapter:
	// the Adapter(id) pre-check above plus the Reactor's single-goroutine loop
	// mean two Consume loops can never be started for one adapter.
	if r.OnInstanceStarted != nil {
		r.OnInstanceStarted(ctx, a)
	}
	return nil
}

// instanceKind extracts the driver Kind from an InstanceID of the form
// "<kind>:<name>", e.g. "claude:default" -> "claude". Routing itself still
// happens on InstanceID everywhere else — this is only used to find which
// Driver builds a not-yet-running instance.
func instanceKind(id provider.InstanceID) provider.Kind {
	if i := strings.Index(string(id), ":"); i >= 0 {
		return provider.Kind(id[:i])
	}
	return provider.Kind(id)
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

// ---------------------------------------------------------------------------
// ThreadDirectory: the in-memory binding of thread -> instance
// ---------------------------------------------------------------------------

// threadDirectory is a mutex-guarded map implementing provider.ThreadDirectory.
// It is intentionally in-memory only: nothing in spec 1 binds a thread to an
// instance yet (that lands with the provider-start flow in a later task), so
// there is nothing here that needs to survive a restart on its own.
type threadDirectory struct {
	mu   sync.Mutex
	byID map[string]provider.InstanceID
}

// NewThreadDirectory returns a fresh, empty provider.ThreadDirectory.
func NewThreadDirectory() provider.ThreadDirectory {
	return &threadDirectory{byID: make(map[string]provider.InstanceID)}
}

func (d *threadDirectory) InstanceFor(threadID string) (provider.InstanceID, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	id, ok := d.byID[threadID]
	return id, ok
}

func (d *threadDirectory) Bind(threadID string, id provider.InstanceID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.byID[threadID] = id
}

func (d *threadDirectory) Unbind(threadID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.byID, threadID)
}

var _ provider.ThreadDirectory = (*threadDirectory)(nil)
