// Local hosting lifecycle — GET/POST /api/memory/local/*. Hub-only, same
// gating as the rest of memory.go. Backs the "Self-hosted on this device"
// Start/Stop control in Settings → Memory, so an operator managing a
// container or bare-metal Hindsight process never has to open a terminal —
// see internal/memoryhost's package comment for the two mechanisms this
// wraps.
package handler

import (
	"net/http"
	"strconv"

	"devdeck/backend/internal/service"
)

func (h *MemoryHandler) writeNotLocal(w http.ResponseWriter, err error) bool {
	if err == service.ErrMemoryHostingNotLocal {
		writeErr(w, http.StatusBadRequest, "hosting is set to manual — nothing for this hub to manage")
		return true
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return true
	}
	return false
}

func (h *MemoryHandler) GetLocalStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.LocalStatus(r.Context())
	if h.writeNotLocal(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// PostLocalStart is synchronous — it blocks until the container/process is
// actually running (or the attempt fails), which on a first-ever start can
// take a while (an image pull, a `uvx` package fetch). The frontend's own
// mutation shows a patient "starting…" state for exactly this call rather
// than polling a separate progress endpoint; see memoryhost.pullTimeout for
// the outer bound.
func (h *MemoryHandler) PostLocalStart(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.LocalStart(r.Context()); err != nil {
		if h.writeNotLocal(w, err) {
			return
		}
	}
	status, err := h.svc.LocalStatus(r.Context())
	if h.writeNotLocal(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *MemoryHandler) PostLocalStop(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.LocalStop(r.Context()); err != nil {
		if h.writeNotLocal(w, err) {
			return
		}
	}
	status, err := h.svc.LocalStatus(r.Context())
	if h.writeNotLocal(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *MemoryHandler) GetLocalLogs(w http.ResponseWriter, r *http.Request) {
	tail := 200
	if v := r.URL.Query().Get("tail"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tail = n
		}
	}
	logs, err := h.svc.LocalLogs(r.Context(), tail)
	if h.writeNotLocal(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"logs": logs})
}
