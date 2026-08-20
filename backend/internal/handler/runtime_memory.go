package handler

import (
	"net/http"

	"devdeck/backend/internal/memory"
	"devdeck/backend/internal/service"
)

// RuntimeMemoryHandler backs /api/runtime/memory/*, the machine-key-gated
// routes a runtime's orchestration hooks call so every runtime shares the
// hub's one Hindsight bank instead of needing its own copy of the config and
// credentials — see domain.MemoryConfig's doc comment and
// machineclient/memory.go, its only caller.
type RuntimeMemoryHandler struct {
	svc *service.MemoryService
}

func NewRuntimeMemoryHandler(svc *service.MemoryService) *RuntimeMemoryHandler {
	return &RuntimeMemoryHandler{svc: svc}
}

type runtimeMemoryScope struct {
	Project  string `json:"project"`
	Machine  string `json:"machine"`
	Provider string `json:"provider"`
	Surface  string `json:"surface"`
	Thread   string `json:"thread"`
}

func (s runtimeMemoryScope) toScope() memory.Scope {
	return memory.Scope{Project: s.Project, Machine: s.Machine, Provider: s.Provider, Surface: s.Surface, Thread: s.Thread}
}

type recallBody struct {
	Scope runtimeMemoryScope `json:"scope"`
	Query string             `json:"query"`
}

// PostRecall handles POST /api/runtime/memory/recall. Always answers 200 with
// whatever block RecallBlock produced (possibly "") — RecallBlock already
// swallows every failure mode (disabled, unreachable, empty result) into "",
// and a calling runtime's own hook degrades the same way, so there is nothing
// here that is ever a client-visible error.
func (h *RuntimeMemoryHandler) PostRecall(w http.ResponseWriter, r *http.Request) {
	if _, ok := MachineFromContext(r.Context()); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body recallBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	block := h.svc.RecallBlock(r.Context(), body.Scope.toScope(), body.Query)
	writeJSON(w, http.StatusOK, map[string]string{"block": block})
}

type retainBody struct {
	Scope runtimeMemoryScope `json:"scope"`
	Role  string             `json:"role"`
	Text  string             `json:"text"`
}

// PostRetain handles POST /api/runtime/memory/retain. Responds as soon as the
// retain is queued — RetainAsync starts its own goroutine and returns
// immediately — so a runtime's Ingestion hook never waits on Hindsight's
// actual fact-extraction call.
func (h *RuntimeMemoryHandler) PostRetain(w http.ResponseWriter, r *http.Request) {
	if _, ok := MachineFromContext(r.Context()); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body retainBody
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	h.svc.RetainAsync(r.Context(), body.Scope.toScope(), body.Role, body.Text)
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}
