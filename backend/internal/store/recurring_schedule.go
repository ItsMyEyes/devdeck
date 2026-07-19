package store

import (
	"encoding/json"
	"strconv"
	"time"

	"devdeck/backend/internal/domain"
)

// daysInMonth returns the number of days in the given month of the given year.
func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func (s *Store) invoiceCount(wsID string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM invoices WHERE workspace_id = ?`, wsID).Scan(&n)
	return n, err
}

type dueTemplateRow struct {
	id, wsID, companyName, companyAddress, itemsJSON string
	bankName, bankAccountName, bankAccountNumber     string
	lastGeneratedYm                                  string
	dayOfMonth, paymentTermDays                       int
}

// RunDueRecurringInvoices generates a draft Invoice for every active
// RecurringInvoiceTemplate whose scheduled day has passed and that hasn't already generated
// one this month, using the current UTC date.
func (s *Store) RunDueRecurringInvoices() ([]domain.Invoice, error) {
	return s.RunDueRecurringInvoicesAt(time.Now().UTC())
}

// RunDueRecurringInvoicesAt is the pure-logic entry point (today is caller-supplied) so
// scheduling behavior can be tested deterministically.
func (s *Store) RunDueRecurringInvoicesAt(today time.Time) ([]domain.Invoice, error) {
	rows, err := s.db.Query(`SELECT id, workspace_id, company_name, company_address, items_json,
		bank_name, bank_account_name, bank_account_number, day_of_month, payment_term_days, last_generated_ym
		FROM recurring_templates WHERE active = 1`)
	if err != nil {
		return nil, err
	}
	var candidates []dueTemplateRow
	for rows.Next() {
		var r dueTemplateRow
		if err := rows.Scan(&r.id, &r.wsID, &r.companyName, &r.companyAddress, &r.itemsJSON,
			&r.bankName, &r.bankAccountName, &r.bankAccountNumber, &r.dayOfMonth, &r.paymentTermDays,
			&r.lastGeneratedYm); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	currentYm := today.Format("2006-01")
	generated := []domain.Invoice{}
	for _, r := range candidates {
		if r.lastGeneratedYm == currentYm {
			continue
		}
		due := r.dayOfMonth
		if max := daysInMonth(today.Year(), today.Month()); due > max {
			due = max
		}
		if today.Day() < due {
			continue
		}
		var items []domain.InvoiceItem
		if r.itemsJSON != "" {
			if err := json.Unmarshal([]byte(r.itemsJSON), &items); err != nil {
				return nil, err
			}
		}
		count, err := s.invoiceCount(r.wsID)
		if err != nil {
			return nil, err
		}
		number := "INV-" + strconv.Itoa(1044+count)
		createdAt := today.Format("2006-01-02")
		dueDate := today.AddDate(0, 0, r.paymentTermDays).Format("2006-01-02")
		iv, err := s.CreateInvoice(r.wsID, number, r.companyName, r.companyAddress, items, dueDate, createdAt, "draft",
			r.bankName, r.bankAccountName, r.bankAccountNumber)
		if err != nil {
			return nil, err
		}
		if _, err := s.db.Exec(`UPDATE recurring_templates SET last_generated_ym = ? WHERE id = ?`, currentYm, r.id); err != nil {
			return nil, err
		}
		generated = append(generated, iv)
	}
	return generated, nil
}
