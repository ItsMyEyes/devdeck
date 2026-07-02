package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// InvoiceHandler handles invoice CRUD endpoints.
type InvoiceHandler struct {
	st *store.Store
}

// NewInvoiceHandler creates an invoice handler.
func NewInvoiceHandler(st *store.Store) *InvoiceHandler {
	return &InvoiceHandler{st: st}
}

func (h *InvoiceHandler) PostInvoice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Number            *string              `json:"number"`
		CompanyName       *string              `json:"companyName"`
		CompanyAddress    *string              `json:"companyAddress"`
		Items             []domain.InvoiceItem `json:"items"`
		DueDate           *string              `json:"dueDate"`
		Status            *string              `json:"status"`
		BankName          *string              `json:"bankName"`
		BankAccountName   *string              `json:"bankAccountName"`
		BankAccountNumber *string              `json:"bankAccountNumber"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// createdAt is a server-assigned timestamp, never client-supplied.
	createdAt := time.Now().UTC().Format("2006-01-02")
	iv, err := h.st.CreateInvoice(
		r.PathValue("wsId"), str(body.Number), str(body.CompanyName), str(body.CompanyAddress),
		body.Items, str(body.DueDate), createdAt, str(body.Status),
		str(body.BankName), str(body.BankAccountName), str(body.BankAccountNumber),
	)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iv)
}

func (h *InvoiceHandler) PatchInvoice(w http.ResponseWriter, r *http.Request) {
	var p port.InvoicePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	iv, err := h.st.UpdateInvoice(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iv)
}

func (h *InvoiceHandler) DeleteInvoice(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteInvoice(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
