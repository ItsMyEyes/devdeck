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
