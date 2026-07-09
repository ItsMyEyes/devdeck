package handler

import (
	"net/http"
	"net/url"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// MachineHandler handles the hub's runtime-machine registry.
type MachineHandler struct {
	st *store.Store
}

func NewMachineHandler(st *store.Store) *MachineHandler {
	return &MachineHandler{st: st}
}

// validMachineURL accepts absolute http/https URLs.
func validMachineURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// GetMachines lists registered machines, keys included: this is the
// key-distribution endpoint for direct-first clients (behind hub auth).
func (h *MachineHandler) GetMachines(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Machines()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *MachineHandler) PostMachine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
		URL  *string `json:"url"`
		Key  *string `json:"key"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Name) == "" || str(body.URL) == "" || str(body.Key) == "" {
		writeErr(w, http.StatusBadRequest, "name, url and key are required")
		return
	}
	if !validMachineURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.CreateMachine(str(body.Name), str(body.URL), str(body.Key))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (h *MachineHandler) PatchMachine(w http.ResponseWriter, r *http.Request) {
	var p port.MachinePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if p.URL != nil && !validMachineURL(*p.URL) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.UpdateMachine(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (h *MachineHandler) DeleteMachine(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteMachine(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
