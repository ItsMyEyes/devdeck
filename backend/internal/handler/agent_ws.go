package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/port"

	"nhooyr.io/websocket"
)

// AgentWSHandler serves /ws/agent, the browser's live connection to a single
// thread's event stream.
//
// Reattach here is EXACT, unlike the ring buffer behind /ws/terminal: the
// client reports the last Seq it saw in "hello", and the server replays
// precisely what the durable log holds after that Seq. Nothing is
// approximated and nothing is guessed from a fixed-size buffer.
type AgentWSHandler struct {
	engine *orchestration.Engine
	store  port.Store
	svc    *provider.Service
}

// NewAgentWSHandler wires the handler to the running engine, the durable
// store (for replay), and the provider service (kept for parity with the
// Reactor's dependencies — Task 9 already owns the actual provider calls).
func NewAgentWSHandler(engine *orchestration.Engine, store port.Store, svc *provider.Service) *AgentWSHandler {
	return &AgentWSHandler{engine: engine, store: store, svc: svc}
}

// wsClientFrame is every inbound message. "hello" and "command" share one
// envelope so the wire protocol has exactly one shape to decode.
type wsClientFrame struct {
	Kind     string                 `json:"kind"`
	ThreadID string                 `json:"threadId,omitempty"`
	SinceSeq uint64                 `json:"sinceSeq,omitempty"`
	Command  *orchestration.Command `json:"command,omitempty"`
}

// wsServerFrame is every outbound message.
type wsServerFrame struct {
	Kind   string                `json:"kind"`
	Events []orchestration.Event `json:"events,omitempty"`
	Error  string                `json:"error,omitempty"`
}

// HandleWS upgrades the request and speaks the /ws/agent protocol:
//
//	client -> server   {"kind":"hello","threadId":"w-abc","sinceSeq":42}
//	client -> server   {"kind":"command","command":{ ...orchestration.Command... }}
//	server -> client   {"kind":"events","events":[ ...orchestration.Event... ]}
//	server -> client   {"kind":"error","error":"message"}
func (h *AgentWSHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		// permessage-deflate breaks WebKit's WebSocket client under
		// sustained output — see terminal.Server.HandleWS for the full
		// story from a live Playwright/webkit repro (iOS Safari and
		// Chrome-iOS share the same engine). Disabling compression here too
		// keeps this socket alive through the same production tunnel.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		log.Printf("agent: websocket accept: %v", err)
		return
	}
	defer conn.CloseNow()
	// Default read limit is 32 KB, which a pasted turn or a large tool
	// payload can exceed easily.
	conn.SetReadLimit(1 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		log.Printf("agent: read hello: %v", err)
		return
	}
	var hello wsClientFrame
	if err := json.Unmarshal(data, &hello); err != nil || hello.Kind != "hello" {
		h.writeError(ctx, conn, "first frame must be hello")
		_ = conn.Close(websocket.StatusPolicyViolation, "expected hello")
		return
	}
	threadID := hello.ThreadID
	log.Printf("agent: thread %s connect", threadID)

	// Subscribe BEFORE snapshotting, not after. Snapshotting first left a
	// window between "read the log up to here" and "start listening for
	// what comes next" during which a commit was durably logged and
	// delivered to neither — permanently invisible, because the client's
	// cursor had already advanced past it. Subscribing first closes that
	// window: a commit landing in the now-harmless gap between subscribe and
	// snapshot instead arrives twice, once in the snapshot and once live, as
	// a duplicate Seq the frontend reducer already discards
	// (event.seq <= view.lastSeq). A silent permanent loss becomes an
	// already-handled duplicate.
	sub, unsub := h.engine.Subscribe(256)
	defer unsub()

	missed, err := h.store.AgentEventsSince(threadID, hello.SinceSeq)
	if err != nil {
		log.Printf("agent: thread %s replay: %v", threadID, err)
		h.writeError(ctx, conn, "replay failed")
		return
	}
	// Send nothing when there is nothing to replay — a client already at
	// head must see silence, not an empty events frame.
	if len(missed) > 0 {
		if err := h.writeEvents(ctx, conn, missed); err != nil {
			return
		}
	}

	// Auto-create is gated on the ENGINE, not on whether the replay came back
	// empty. Those are different questions, and conflating them is what made
	// a restarted server reject every turn with "thread X does not exist":
	// the log still held the thread's events, so `missed` was non-empty and
	// this branch was skipped — while the engine, whose State is derived and
	// was rebuilt empty, had never heard of the thread. Asking the engine
	// directly is the question that actually matters, and it is also cheaper
	// in the common case (a thread already in state skips the dispatch and
	// its receipt lookup entirely).
	if _, known := h.engine.State().Thread(threadID); !known {
		if err := h.autoCreateThread(ctx, threadID); err != nil {
			// Non-fatal: a genuine failure here is almost always an
			// unresolvable worktree/agent. Surface it and keep the socket
			// open rather than kill a connection that might still be useful
			// for retries.
			log.Printf("agent: thread %s auto-create: %v", threadID, err)
			h.writeError(ctx, conn, "failed to initialize thread")
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer cancel()
		h.writeLoop(ctx, conn, sub, threadID)
	}()
	go func() {
		defer wg.Done()
		defer cancel()
		h.readLoop(ctx, conn, threadID)
	}()
	wg.Wait()

	// The engine is never touched here. Closing this socket must not stop
	// the session or interrupt a turn — exactly the PTY contract, where
	// closing a terminal tab leaves the process running for reattach.
	log.Printf("agent: thread %s disconnect", threadID)
}

// writeLoop forwards every batch published by the engine, filtered to this
// socket's thread. A slow subscriber drops batches by design (see
// Engine.publish) — the client recovers by reconnecting with its last Seq,
// which is exactly why exact replay exists.
func (h *AgentWSHandler) writeLoop(ctx context.Context, conn *websocket.Conn, sub <-chan []orchestration.Event, threadID string) {
	for {
		select {
		case <-ctx.Done():
			return
		case batch, ok := <-sub:
			if !ok {
				return
			}
			filtered := make([]orchestration.Event, 0, len(batch))
			for _, e := range batch {
				// Route on ThreadID: Subscribe is engine-wide (every
				// thread), one socket serves exactly one thread.
				if e.ThreadID == threadID {
					filtered = append(filtered, e)
				}
			}
			if len(filtered) == 0 {
				continue
			}
			if err := h.writeEvents(ctx, conn, filtered); err != nil {
				return
			}
		}
	}
}

func (h *AgentWSHandler) readLoop(ctx context.Context, conn *websocket.Conn, threadID string) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var f wsClientFrame
		if err := json.Unmarshal(data, &f); err != nil {
			h.writeError(ctx, conn, "invalid frame")
			continue
		}
		switch f.Kind {
		case "command":
			h.handleCommand(ctx, conn, threadID, f.Command)
		case "hello":
			// A second hello on an already-open socket is a no-op; a client
			// that wants a fresh replay reconnects instead.
		default:
			h.writeError(ctx, conn, fmt.Sprintf("unknown frame kind %q", f.Kind))
		}
	}
}

func (h *AgentWSHandler) handleCommand(ctx context.Context, conn *websocket.Conn, threadID string, cmd *orchestration.Command) {
	if cmd == nil {
		h.writeError(ctx, conn, "command frame missing command")
		return
	}
	// A client must never be able to forge server-only facts (assistant
	// output, session state) by dispatching the commands that produce them.
	if !orchestration.ClientDispatchable[cmd.Type] {
		h.writeError(ctx, conn, fmt.Sprintf("command %s is not client-dispatchable", cmd.Type))
		return
	}
	c := *cmd
	if c.ThreadID == "" {
		c.ThreadID = threadID
	}
	// A dispatch error becomes an error frame, never a closed socket — the
	// user might just be re-approving the same request from a second tab.
	if _, err := h.engine.Dispatch(ctx, c); err != nil {
		h.writeError(ctx, conn, err.Error())
	}
}

// autoCreateThread provisions a thread the first time a client says hello to
// it — hello for a thread with no durable events is the only signal the
// engine gets that nothing has created it yet. The CommandID is derived from
// threadID, not random, so a reconnect that finds the thread already there
// resends an identical command and is absorbed by SeenCommand rather than
// failing with "thread already exists".
func (h *AgentWSHandler) autoCreateThread(ctx context.Context, threadID string) error {
	instanceID, err := h.resolveInstanceID(threadID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(struct {
		InstanceID string `json:"instanceId"`
	}{InstanceID: instanceID})
	if err != nil {
		return err
	}
	_, err = h.engine.Dispatch(ctx, orchestration.Command{
		CommandID: "ac-create-" + threadID,
		Type:      orchestration.CmdThreadCreate,
		ThreadID:  threadID,
		Payload:   payload,
	})
	return err
}

// resolveInstanceID maps a thread to the InstanceID of its worktree's
// configured agent, mirroring main.go's Reactor.InstanceFor. A threadID is
// either a bare worktree id or "<worktreeId>::chat-N" for extra split chat
// panes (see paneTree.ts) — both name the same worktree, so only the prefix
// before "::" is looked up.
//
// An SSH thread (orchestration.IsSSHThread) has no worktree at all — the
// WorktreeByID lookup below would simply fail "not found" for it — so it is
// resolved to the default agent instance directly, the same fallback
// InstanceIDForAgent("") and Reactor.InstanceFor's SSH branch both take.
func (h *AgentWSHandler) resolveInstanceID(threadID string) (string, error) {
	if orchestration.IsSSHThread(threadID) {
		return string(orchestration.InstanceIDForAgent("")), nil
	}
	wt, err := h.store.WorktreeByID(orchestration.WorktreeIDForThread(threadID))
	if err != nil {
		return "", fmt.Errorf("agent thread %s: %w", threadID, err)
	}
	return string(orchestration.InstanceIDForAgent(wt.Agent)), nil
}

func (h *AgentWSHandler) writeEvents(ctx context.Context, conn *websocket.Conn, evts []orchestration.Event) error {
	return h.writeFrame(ctx, conn, wsServerFrame{Kind: "events", Events: evts})
}

func (h *AgentWSHandler) writeError(ctx context.Context, conn *websocket.Conn, msg string) {
	_ = h.writeFrame(ctx, conn, wsServerFrame{Kind: "error", Error: msg})
}

func (h *AgentWSHandler) writeFrame(ctx context.Context, conn *websocket.Conn, f wsServerFrame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}
