package handler

import (
	"net/http"
	"time"

	"devdeck/backend/internal/port"
)

// HealthHandler handles health-check requests.
type HealthHandler struct{}

// NewHealthHandler creates a health handler.
func NewHealthHandler() *HealthHandler { return &HealthHandler{} }

// ServeHTTP returns a simple health status.
func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// WhoamiHandler answers an authenticated liveness probe. Unlike
// /api/health (deliberately exempt from auth — see RequireKey/RequireAuth's
// public-path allowlists), this route is gated by the normal auth
// middleware: reaching it with a 200 proves both reachability and a
// correct credential. Used by machineclient.Probe before registering a new
// machine (see MachineHandler.PostMachine).
type WhoamiHandler struct {
	role        string
	machineName string
	store       port.Store // nil on the hub; only runtimes report sync state
}

// NewWhoamiHandler creates a whoami handler. role is "hub" or "runtime";
// machineName is this process's display name when it is a runtime. Pass a
// non-nil store on runtimes so the response can report catalog freshness via
// lastSyncedAt; pass nil on the hub (and on --role both), which never
// replicates a catalog and so never has sync state to report.
func NewWhoamiHandler(role, machineName string, s port.Store) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName, store: s}
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
