package handler

import (
	"net/http"
	"sync"
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
	hubURL      string     // configured --hub-url; empty on the hub and on a runtime that never set it
	machineIDMu sync.RWMutex
	machineID   string // this runtime's own hub-assigned id, once self-registration succeeds; empty until then
}

// NewWhoamiHandler creates a whoami handler. role is "hub" or "runtime";
// machineName is this process's display name when it is a runtime. Pass a
// non-nil store on runtimes so the response can report catalog freshness via
// lastSyncedAt; pass nil on the hub (and on --role both), which never
// replicates a catalog and so never has sync state to report. hubURL and
// machineID are only ever non-empty on a --role runtime process (machineID
// may still be empty briefly, before self-registration first succeeds) —
// the frontend uses both to build the "Sign in via hub" redirect.
func NewWhoamiHandler(role, machineName string, s port.Store, hubURL, machineID string) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName, store: s, hubURL: hubURL, machineID: machineID}
}

// SetMachineID updates the machine id this handler reports, once
// self-registration succeeds. Safe to call from a different goroutine than
// the one serving requests.
func (h *WhoamiHandler) SetMachineID(id string) {
	h.machineIDMu.Lock()
	h.machineID = id
	h.machineIDMu.Unlock()
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.machineIDMu.RLock()
	machineID := h.machineID
	h.machineIDMu.RUnlock()

	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
		"hubUrl":       h.hubURL,
		"machineId":    machineID,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
