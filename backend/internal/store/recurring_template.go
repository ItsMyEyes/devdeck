package store

import (
	"encoding/json"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const recurringTemplateColumns = `id, company_name, company_address, items_json, bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, active, last_generated_ym, created_at`

func scanRecurringTemplate(sc scanner) (domain.RecurringInvoiceTemplate, error) {
	var t domain.RecurringInvoiceTemplate
	var itemsJSON string
	var active int
	err := sc.Scan(&t.ID, &t.CompanyName, &t.CompanyAddress, &itemsJSON,
		&t.BankDetail.BankName, &t.BankDetail.AccountName, &t.BankDetail.AccountNumber,
		&t.DayOfMonth, &t.PaymentTermDays, &active, &t.LastGeneratedYm, &t.CreatedAt)
	if err != nil {
		return t, err
	}
	t.Active = active != 0
	if itemsJSON == "" {
		t.Items = []domain.InvoiceItem{}
	} else if err := json.Unmarshal([]byte(itemsJSON), &t.Items); err != nil {
		return t, err
	}
	if t.Items == nil {
		t.Items = []domain.InvoiceItem{}
	}
	return t, nil
}

func (s *Store) recurringTemplatesOf(wsID string) ([]domain.RecurringInvoiceTemplate, error) {
	rows, err := s.db.Query(`SELECT `+recurringTemplateColumns+` FROM recurring_templates WHERE workspace_id = ? ORDER BY rowid DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.RecurringInvoiceTemplate{}
	for rows.Next() {
		t, err := scanRecurringTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) recurringTemplateByID(id string) (domain.RecurringInvoiceTemplate, error) {
	t, err := scanRecurringTemplate(s.db.QueryRow(`SELECT `+recurringTemplateColumns+` FROM recurring_templates WHERE id = ?`, id))
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, mapNotFound(err)
	}
	return t, nil
}

// CreateRecurringTemplate creates a recurring invoice template for a workspace. dayOfMonth is
// clamped to 1..28 so every month-length edge case (Feb, 30-day months) is a pure display/
// scheduling concern, never a stored out-of-range value.
func (s *Store) CreateRecurringTemplate(wsID, companyName, companyAddress string, items []domain.InvoiceItem, bankName, bankAccountName, bankAccountNumber string, dayOfMonth, paymentTermDays int, createdAt string) (domain.RecurringInvoiceTemplate, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if !ok {
		return domain.RecurringInvoiceTemplate{}, ErrNotFound
	}
	if dayOfMonth < 1 {
		dayOfMonth = 1
	}
	if dayOfMonth > 28 {
		dayOfMonth = 28
	}
	if paymentTermDays < 0 {
		paymentTermDays = 0
	}
	if items == nil {
		items = []domain.InvoiceItem{}
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	id := idGen("rt-")
	if _, err := s.db.Exec(`INSERT INTO recurring_templates (id, workspace_id, company_name, company_address, items_json, bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, active, last_generated_ym, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', ?)`,
		id, wsID, companyName, companyAddress, string(itemsJSON), bankName, bankAccountName, bankAccountNumber, dayOfMonth, paymentTermDays, createdAt); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	return s.recurringTemplateByID(id)
}

// UpdateRecurringTemplate applies a partial update to a recurring template.
func (s *Store) UpdateRecurringTemplate(id string, p port.RecurringTemplatePatch) (domain.RecurringInvoiceTemplate, error) {
	if _, err := s.recurringTemplateByID(id); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if err := firstErr(
		setStr(s.db, "recurring_templates", "company_name", id, p.CompanyName),
		setStr(s.db, "recurring_templates", "company_address", id, p.CompanyAddress),
		setStr(s.db, "recurring_templates", "bank_name", id, p.BankName),
		setStr(s.db, "recurring_templates", "bank_account_name", id, p.BankAccountName),
		setStr(s.db, "recurring_templates", "bank_account_number", id, p.BankAccountNumber),
		setInt(s.db, "recurring_templates", "day_of_month", id, p.DayOfMonth),
		setInt(s.db, "recurring_templates", "payment_term_days", id, p.PaymentTermDays),
	); err != nil {
		return domain.RecurringInvoiceTemplate{}, err
	}
	if p.Active != nil {
		if _, err := s.db.Exec(`UPDATE recurring_templates SET active = ? WHERE id = ?`, boolInt(*p.Active), id); err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
	}
	if p.Items != nil {
		itemsJSON, err := json.Marshal(*p.Items)
		if err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
		if _, err := s.db.Exec(`UPDATE recurring_templates SET items_json = ? WHERE id = ?`, string(itemsJSON), id); err != nil {
			return domain.RecurringInvoiceTemplate{}, err
		}
	}
	return s.recurringTemplateByID(id)
}

// DeleteRecurringTemplate deletes a recurring template.
func (s *Store) DeleteRecurringTemplate(id string) error {
	res, err := s.db.Exec(`DELETE FROM recurring_templates WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
