package handler

import (
	"net/http"

	"loom/backend/internal/store"
)

// EventHandler serves an issue's auto-recorded Activity timeline. Read-only —
// events are a side effect of PatchIssue, never authored directly.
type EventHandler struct {
	st *store.Store
}

// NewEventHandler creates an event handler.
func NewEventHandler(st *store.Store) *EventHandler {
	return &EventHandler{st: st}
}

// ListEvents returns an issue's timeline of auto-recorded field changes.
func (h *EventHandler) ListEvents(w http.ResponseWriter, r *http.Request) {
	events, err := h.st.ListIssueEvents(r.PathValue("issueId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, events)
}
