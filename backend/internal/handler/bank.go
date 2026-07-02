package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// BankHandler handles bank-preset CRUD endpoints.
type BankHandler struct {
	st *store.Store
}

// NewBankHandler creates a bank handler.
func NewBankHandler(st *store.Store) *BankHandler {
	return &BankHandler{st: st}
}

// GetBanks returns all saved bank presets.
func (h *BankHandler) GetBanks(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Banks()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostBank creates a bank preset.
func (h *BankHandler) PostBank(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BankName      *string `json:"bankName"`
		AccountName   *string `json:"accountName"`
		AccountNumber *string `json:"accountNumber"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	b, err := h.st.CreateBank(str(body.BankName), str(body.AccountName), str(body.AccountNumber))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// PatchBank updates a bank preset.
func (h *BankHandler) PatchBank(w http.ResponseWriter, r *http.Request) {
	var p port.BankPatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	b, err := h.st.UpdateBank(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// DeleteBank deletes a bank preset.
func (h *BankHandler) DeleteBank(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteBank(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
