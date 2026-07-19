package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// CompanyHandler handles company-preset CRUD endpoints.
type CompanyHandler struct {
	st *store.Store
}

// NewCompanyHandler creates a company handler.
func NewCompanyHandler(st *store.Store) *CompanyHandler {
	return &CompanyHandler{st: st}
}

// GetCompanies returns all saved company presets.
func (h *CompanyHandler) GetCompanies(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Companies()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostCompany creates a company preset.
func (h *CompanyHandler) PostCompany(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         *string `json:"name"`
		ShortAddress *string `json:"shortAddress"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, err := h.st.CreateCompany(str(body.Name), str(body.ShortAddress))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// PatchCompany updates a company preset.
func (h *CompanyHandler) PatchCompany(w http.ResponseWriter, r *http.Request) {
	var p port.CompanyPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	c, err := h.st.UpdateCompany(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// DeleteCompany deletes a company preset.
func (h *CompanyHandler) DeleteCompany(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteCompany(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
