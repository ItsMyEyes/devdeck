package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// SettingsHandler handles settings endpoints.
type SettingsHandler struct {
	st *store.Store
}

// NewSettingsHandler creates a settings handler.
func NewSettingsHandler(st *store.Store) *SettingsHandler {
	return &SettingsHandler{st: st}
}

// GetSettings returns the singleton settings row.
func (h *SettingsHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	set, err := h.st.Settings()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, set)
}

// PutSettings applies a partial settings update.
func (h *SettingsHandler) PutSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActiveWorkspaceID *string `json:"activeWorkspaceId"`
		DefaultModel      *string `json:"defaultModel"`
	}
	raw, err := decodeBody(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	p := port.SettingsPatch{DefaultModel: body.DefaultModel}
	if _, ok := raw["activeWorkspaceId"]; ok {
		p.HasActive = true
		p.ActiveWorkspaceID = body.ActiveWorkspaceID
	}
	set, err := h.st.UpdateSettings(p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, set)
}
