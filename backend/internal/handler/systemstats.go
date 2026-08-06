package handler

import (
	"net/http"

	"devdeck/backend/internal/hoststats"
)

// SystemStatsHandler serves this machine's own live CPU/memory/disk sample.
// Registered on every role: measuring a runtime is the primary use case, so
// unlike most hub routes this one is deliberately not role-gated.
type SystemStatsHandler struct {
	collector *hoststats.Collector
}

func NewSystemStatsHandler(collector *hoststats.Collector) *SystemStatsHandler {
	return &SystemStatsHandler{collector: collector}
}

func (h *SystemStatsHandler) Get(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	stats, err := h.collector.Collect()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}
