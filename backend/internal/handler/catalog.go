package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
)

// CatalogHandler serves a runtime's slice of the hub catalog.
type CatalogHandler struct{ store port.Store }

// NewCatalogHandler creates a catalog handler.
func NewCatalogHandler(s port.Store) *CatalogHandler { return &CatalogHandler{store: s} }

// GetCatalog handles GET /api/runtime/catalog. The machine is taken from the
// request context (RequireMachineKey), never from a parameter.
func (h *CatalogHandler) GetCatalog(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	snap, err := h.store.CatalogForMachine(m.ID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, snap)
}
