package handler

import "net/http"

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
}

// NewWhoamiHandler creates a whoami handler. role is "hub" or "runtime";
// machineName is this process's display name when it is a runtime.
func NewWhoamiHandler(role, machineName string) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName}
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":      "ok",
		"role":        h.role,
		"machineName": h.machineName,
	})
}
