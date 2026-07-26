package handler

import "net/http"

// HubKeyHandler hands this hub's own bearer key to an authenticated caller so
// the Add-runtime dialog can build a copy-pasteable install command. See
// docs/superpowers/specs/2026-07-26-runtime-install-command-design.md.
//
// Registered only on --role hub and --role both (main.go) — a pure runtime has
// no hub key to hand out. The key is a long-lived credential, so the response
// is marked no-store and the key is never logged. A bearer-key caller had to
// present this same key to get past RequireAuth, so it learns nothing new; a
// cookie-session caller is the operator.
type HubKeyHandler struct {
	hubKey string
}

// NewHubKeyHandler creates a hub-key handler. hubKey is main.go's --key value,
// which is empty when the hub was started without one.
func NewHubKeyHandler(hubKey string) *HubKeyHandler {
	return &HubKeyHandler{hubKey: hubKey}
}

type hubKeyResponse struct {
	Configured bool   `json:"configured"`
	Key        string `json:"key"`
}

// ServeHTTP reports the hub key, or configured:false when this hub has none.
func (h *HubKeyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.hubKey == "" {
		writeJSON(w, http.StatusOK, hubKeyResponse{})
		return
	}
	writeJSON(w, http.StatusOK, hubKeyResponse{Configured: true, Key: h.hubKey})
}
