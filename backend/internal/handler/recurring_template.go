package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// RecurringTemplateHandler handles recurring-invoice-template CRUD endpoints.
type RecurringTemplateHandler struct {
	st *store.Store
}

// NewRecurringTemplateHandler creates a recurring template handler.
func NewRecurringTemplateHandler(st *store.Store) *RecurringTemplateHandler {
	return &RecurringTemplateHandler{st: st}
}

func intOr(v *int, fallback int) int {
	if v == nil {
		return fallback
	}
	return *v
}

// PostRecurringTemplate creates a recurring invoice template for a workspace.
func (h *RecurringTemplateHandler) PostRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyName       *string              `json:"companyName"`
		CompanyAddress    *string              `json:"companyAddress"`
		Items             []domain.InvoiceItem `json:"items"`
		BankName          *string              `json:"bankName"`
		BankAccountName   *string              `json:"bankAccountName"`
		BankAccountNumber *string              `json:"bankAccountNumber"`
		DayOfMonth        *int                 `json:"dayOfMonth"`
		PaymentTermDays   *int                 `json:"paymentTermDays"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	createdAt := time.Now().UTC().Format("2006-01-02")
	tpl, err := h.st.CreateRecurringTemplate(
		r.PathValue("wsId"), str(body.CompanyName), str(body.CompanyAddress), body.Items,
		str(body.BankName), str(body.BankAccountName), str(body.BankAccountNumber),
		intOr(body.DayOfMonth, 1), intOr(body.PaymentTermDays, 14), createdAt,
	)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

// PatchRecurringTemplate updates a recurring invoice template.
func (h *RecurringTemplateHandler) PatchRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	var p port.RecurringTemplatePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tpl, err := h.st.UpdateRecurringTemplate(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

// DeleteRecurringTemplate deletes a recurring invoice template.
func (h *RecurringTemplateHandler) DeleteRecurringTemplate(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteRecurringTemplate(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
