package handler

import (
	"net/http"

	"devdeck/backend/internal/terminal"
)

// AgentRunCounter is the slice of the orchestration engine this handler needs
// — an interface, not *orchestration.Engine, so a test can count without
// booting an engine. Satisfied by *orchestration.Engine.BusyThreadCount.
type AgentRunCounter interface {
	BusyThreadCount() int
}

// activeTerminalCount is the PTY half of the signal, kept as a swappable
// package-level var for the same reason self.go keeps spawnReplacement and
// exitProcess that way: internal/terminal's session registry is private to
// that package, so a handler test has no way to spawn a session to count.
var activeTerminalCount = terminal.ActiveSessionCount

// BusyHandler answers "what would a restart of this process destroy?" —
// separately from SelfHandler on purpose. main.go builds selfH long before the
// orchestration engine exists (see cmd/server/main.go), so the engine cannot be
// a SelfHandler construction argument; this handler is built after the engine
// instead. See decision D3 of
// docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md.
//
// It exists because the update-check response's activeSessions counts PTY
// sessions only, leaving an agent run with no attached terminal invisible — so
// "safe to restart?" was under-reported exactly when it mattered.
type BusyHandler struct {
	// engine may be nil: a process with no orchestration engine reports zero
	// agent runs, mirroring how terminal.ActiveSessionCount() reports zero on
	// a process with no terminal registry. Advisory counts must degrade to a
	// number, never to an error — the desktop updater shows them next to a
	// destructive action and must still be able to render the prompt.
	engine AgentRunCounter
}

// NewBusyHandler creates the busy-signal handler. A nil engine is valid.
func NewBusyHandler(engine AgentRunCounter) *BusyHandler {
	return &BusyHandler{engine: engine}
}

// GetBusy handles GET /api/self/busy. Network-free and cheap on both counts,
// so a caller can poll it before offering a restart.
func (h *BusyHandler) GetBusy(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]int{
		"terminals": activeTerminalCount(),
		"agentRuns": h.agentRuns(),
	})
}

func (h *BusyHandler) agentRuns() int {
	// Two nils to survive, not one: no engine wired at all, and a typed-nil
	// *orchestration.Engine handed over as a non-nil interface value. The
	// engine's own method guards the second case; the check here covers the
	// first, where there is no method to call.
	if h == nil || h.engine == nil {
		return 0
	}
	return h.engine.BusyThreadCount()
}
