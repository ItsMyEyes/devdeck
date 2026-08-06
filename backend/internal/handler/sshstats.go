package handler

import (
	"net/http"

	"devdeck/backend/internal/service"
)

// SSHStatsHandler serves live CPU/memory/disk for a saved SSH connection.
// Hub-scoped like the rest of the SSH API: the hub holds the credentials, and
// only the outbound dial moves to the connection's executor machine.
type SSHStatsHandler struct {
	svc *service.SSHStatsService
}

func NewSSHStatsHandler(svc *service.SSHStatsService) *SSHStatsHandler {
	return &SSHStatsHandler{svc: svc}
}

func (h *SSHStatsHandler) Get(w http.ResponseWriter, r *http.Request) {
	stats, err := h.svc.Collect(r.Context(), r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, stats)
}
