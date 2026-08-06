package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
)

// sshStatsCollector is the one method this handler needs. Declared as an
// interface so both response shapes — the 200 carrying a sample and the
// {"error":...} envelope a transport failure produces — are testable without
// a live SSH host.
type sshStatsCollector interface {
	Collect(ctx context.Context, connectionID string) (domain.HostStats, error)
}

// SSHStatsHandler serves live CPU/memory/disk for a saved SSH connection.
// Hub-scoped like the rest of the SSH API: the hub holds the credentials, and
// only the outbound dial moves to the connection's executor machine.
type SSHStatsHandler struct {
	svc sshStatsCollector
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
