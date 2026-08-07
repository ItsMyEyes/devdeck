package orchestration

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
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

	mu      sync.Mutex
	buffers map[string]*assistantBuffer // key: threadID|turnID|itemID
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

func (in *Ingestion) handle(ctx context.Context, ev event.Event) error {
	switch ev.Type {

	case event.ContentDelta:
		p, ok := ev.Payload.(*event.ContentDeltaPayload)
		if !ok {
			return nil
		}
		if in.Delivery.Buffered && p.Stream == event.StreamText {
			return in.appendBuffered(ctx, ev, p)
		}
		return in.emitDelta(ctx, ev, p.Text, p.Stream, p.Sequence)

	case event.RequestOpened, event.UserInputRequested:
		// Flush first, then record the request. The order determines what
		// the user sees.
		if err := in.flushThread(ctx, ev.ThreadID); err != nil {
			return err
		}
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
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{"status": string(ThreadIdle)}),
		})

	case event.SessionExited:
		// Session died: clean up pending approvals, don't wait for a timeout.
		in.Broker.CancelThread(ev.ThreadID)
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{"status": string(ThreadStopped)}),
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
// Reactor: engine event -> provider call
// ---------------------------------------------------------------------------

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
}

func (r *Reactor) Run(ctx context.Context) {
	sub, unsub := r.Engine.Subscribe(256)
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
}

func (r *Reactor) react(ctx context.Context, e Event) error {
	switch e.Type {
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
		_, err := r.Provider.SendTurn(ctx, provider.SendTurnInput{
			ThreadID:    e.ThreadID,
			TurnID:      e.EventID,
			Text:        p.Text,
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
		return r.Provider.RespondToRequest(ctx, e.ThreadID, p.RequestID, p.Decision)

	case EvtThreadTurnInterruptRequested:
		st := r.Engine.State()
		t, ok := st.Thread(e.ThreadID)
		if !ok {
			return nil
		}
		// Cancel pending approvals FIRST. Otherwise the interrupt would wait
		// on a turn that is itself waiting on the user.
		r.Broker.CancelThread(e.ThreadID)
		return r.Provider.InterruptTurn(ctx, e.ThreadID, t.CurrentTurn)

	case EvtThreadSessionStopRequested:
		r.Broker.CancelThread(e.ThreadID)
		a, err := r.Provider.Registry.Adapter(mustInstance(r.Engine, e.ThreadID))
		if err != nil {
			return err
		}
		return a.StopSession(ctx, e.ThreadID)
	}
	return nil
}

func mustInstance(e *Engine, threadID string) provider.InstanceID {
	if t, ok := e.State().Thread(threadID); ok {
		return t.InstanceID
	}
	return ""
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
