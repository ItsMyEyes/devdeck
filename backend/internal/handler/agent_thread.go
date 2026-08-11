package handler

import (
	"net/http"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// AgentThreadHandler serves the sessions sidebar: the list of chat threads
// that exist for a worktree, and deleting one.
type AgentThreadHandler struct {
	store  port.Store
	engine *orchestration.Engine
}

// NewAgentThreadHandler returns a handler wired to the given store and engine.
// The engine is needed by DeleteThread only — the list is a pure read-model
// query.
func NewAgentThreadHandler(st port.Store, engine *orchestration.Engine) *AgentThreadHandler {
	return &AgentThreadHandler{store: st, engine: engine}
}

// GetThreads handles GET /api/agent/threads?worktree=<id>, returning a
// worktree's chat threads newest-touched first.
func (h *AgentThreadHandler) GetThreads(w http.ResponseWriter, r *http.Request) {
	worktreeID := r.URL.Query().Get("worktree")
	if worktreeID == "" {
		writeErr(w, http.StatusBadRequest, "worktree is required")
		return
	}
	threads, err := h.store.AgentThreads(worktreeID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withLiveStatus(threads))
}

// withLiveStatus replaces each row's stored status with the engine's.
//
// `agent_thread.status` is written once, as "idle", when the thread is created
// and never updated — so the sidebar said "Idle" next to a thread the chat
// header was showing as "Running". The obvious fix is to project every status
// transition into the row alongside the event, and it is the wrong one: those
// transitions are real rules (a turn is only back to running once the LAST
// pending approval clears; a session event carries its own status), they live
// in the decider's projector, and a SQL copy of them is a second
// implementation to keep in step.
//
// The engine already holds the answer, computed by the one implementation that
// owns it. Reading it here costs a map lookup per row and cannot drift. A
// thread the engine has never heard of keeps its stored value rather than
// being blanked — that should not happen now the log is replayed on boot, but
// showing a stale status beats showing none.
func (h *AgentThreadHandler) withLiveStatus(threads []domain.AgentThread) []domain.AgentThread {
	if h.engine == nil {
		return threads
	}
	state := h.engine.State()
	for i, t := range threads {
		if live, ok := state.Thread(t.ID); ok {
			threads[i].Status = string(live.Status)
		}
	}
	return threads
}

// DeleteThread handles DELETE /api/agent/threads/{threadId}: erase a chat
// session — its sidebar row, its event log and its command receipts.
//
// Store first, engine second. The store call is the durable one; if it fails
// nothing has changed and the client gets an error. Dropping the thread from
// the engine's in-memory state only after it succeeds keeps the same ordering
// invariant Engine.process holds — memory never gets ahead of the log.
//
// Any socket still open on this thread keeps working: its next command
// auto-creates the thread again from scratch, which is the correct outcome for
// a pane whose conversation was just erased.
func (h *AgentThreadHandler) DeleteThread(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeErr(w, http.StatusBadRequest, "threadId is required")
		return
	}
	if err := h.store.DeleteAgentThread(threadID); handleStoreErr(w, err) {
		return
	}
	h.engine.ForgetThread(threadID)
	w.WriteHeader(http.StatusNoContent)
}
