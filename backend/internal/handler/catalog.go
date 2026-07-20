package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

// CatalogHandler serves a runtime's slice of the hub catalog, and accepts
// replayed projects a runtime created while the hub was unreachable.
type CatalogHandler struct {
	store   port.Store
	catalog *service.CatalogService
}

// NewCatalogHandler creates a catalog handler.
func NewCatalogHandler(s port.Store, catalog *service.CatalogService) *CatalogHandler {
	return &CatalogHandler{store: s, catalog: catalog}
}

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

// PostProject handles POST /api/runtime/projects — a runtime replaying a
// project it created locally while the hub was unreachable. machineId is
// never read from the body: it always comes from the authenticated caller.
func (h *CatalogHandler) PostProject(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId"`
		Name        string `json:"name"`
		Path        string `json:"path"`
		Repo        string `json:"repo"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.ID == "" || body.WorkspaceID == "" {
		writeErr(w, http.StatusBadRequest, "id and workspaceId are required")
		return
	}
	p, err := h.catalog.ReplayProject(m.ID, service.ReplayProjectRequest{
		ID:          body.ID,
		WorkspaceID: body.WorkspaceID,
		Name:        body.Name,
		Path:        body.Path,
		Repo:        body.Repo,
	})
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}
