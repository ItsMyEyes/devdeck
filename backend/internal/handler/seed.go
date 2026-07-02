package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// SeedHandler handles the seed endpoint.
type SeedHandler struct {
	svc *service.SeedService
}

// NewSeedHandler creates a seed handler.
func NewSeedHandler(svc *service.SeedService) *SeedHandler {
	return &SeedHandler{svc: svc}
}

// PostSeed wipes all data and inserts the demo dataset.
func (h *SeedHandler) PostSeed(w http.ResponseWriter, r *http.Request) {
	list, err := h.svc.Seed()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}
