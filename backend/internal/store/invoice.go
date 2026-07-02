package store

import (
	"encoding/json"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const invoiceColumns = `id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number`

func scanInvoice(sc scanner) (domain.Invoice, error) {
	var iv domain.Invoice
	var itemsJSON string
	err := sc.Scan(&iv.ID, &iv.Number, &iv.CompanyName, &iv.CompanyAddress, &itemsJSON, &iv.Amount, &iv.Status, &iv.DueDate, &iv.CreatedAt,
		&iv.BankDetail.BankName, &iv.BankDetail.AccountName, &iv.BankDetail.AccountNumber)
	if err != nil {
		return iv, err
	}
	if itemsJSON == "" {
		iv.Items = []domain.InvoiceItem{}
	} else if err := json.Unmarshal([]byte(itemsJSON), &iv.Items); err != nil {
		return iv, err
	}
	if iv.Items == nil {
		iv.Items = []domain.InvoiceItem{}
	}
	return iv, nil
}

func (s *Store) invoicesOf(wsID string) ([]domain.Invoice, error) {
	rows, err := s.db.Query(`SELECT `+invoiceColumns+` FROM invoices WHERE workspace_id = ? ORDER BY rowid DESC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Invoice{}
	for rows.Next() {
		iv, err := scanInvoice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, iv)
	}
	return out, rows.Err()
}

func (s *Store) invoiceByID(id string) (domain.Invoice, error) {
	iv, err := scanInvoice(s.db.QueryRow(`SELECT `+invoiceColumns+` FROM invoices WHERE id = ?`, id))
	if err != nil {
		return domain.Invoice{}, mapNotFound(err)
	}
	return iv, nil
}

// itemsTotal sums quantity * unitPrice across all items.
func itemsTotal(items []domain.InvoiceItem) float64 {
	var total float64
	for _, it := range items {
		total += it.Quantity * it.UnitPrice
	}
	return total
}

// CreateInvoice creates an invoice. companyName/companyAddress and the bank
// fields are caller-supplied snapshots (typically copied from a Company/Bank
// preset) — Invoice does not hold a foreign key to either.
func (s *Store) CreateInvoice(wsID, number, companyName, companyAddress string, items []domain.InvoiceItem, dueDate, createdAt, status, bankName, bankAccountName, bankAccountNumber string) (domain.Invoice, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Invoice{}, err
	}
	if !ok {
		return domain.Invoice{}, ErrNotFound
	}
	if companyName == "" {
		companyName = "Untitled client"
	}
	if dueDate == "" {
		dueDate = "—"
	}
	if status == "" {
		status = "draft"
	}
	if items == nil {
		items = []domain.InvoiceItem{}
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return domain.Invoice{}, err
	}
	id := idGen("iv-")
	if _, err := s.db.Exec(`INSERT INTO invoices (id, workspace_id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, wsID, number, companyName, companyAddress, string(itemsJSON), itemsTotal(items), status, dueDate, createdAt,
		bankName, bankAccountName, bankAccountNumber); err != nil {
		return domain.Invoice{}, err
	}
	return s.invoiceByID(id)
}

func (s *Store) UpdateInvoice(id string, p port.InvoicePatch) (domain.Invoice, error) {
	if _, err := s.invoiceByID(id); err != nil {
		return domain.Invoice{}, err
	}
	if err := firstErr(
		setStr(s.db, "invoices", "number", id, p.Number),
		setStr(s.db, "invoices", "company_name", id, p.CompanyName),
		setStr(s.db, "invoices", "company_address", id, p.CompanyAddress),
		setStr(s.db, "invoices", "due_date", id, p.DueDate),
		setStr(s.db, "invoices", "status", id, p.Status),
		setStr(s.db, "invoices", "bank_name", id, p.BankName),
		setStr(s.db, "invoices", "bank_account_name", id, p.BankAccountName),
		setStr(s.db, "invoices", "bank_account_number", id, p.BankAccountNumber),
	); err != nil {
		return domain.Invoice{}, err
	}
	if p.Items != nil {
		itemsJSON, err := json.Marshal(*p.Items)
		if err != nil {
			return domain.Invoice{}, err
		}
		if _, err := s.db.Exec(`UPDATE invoices SET items_json = ?, amount = ? WHERE id = ?`,
			string(itemsJSON), itemsTotal(*p.Items), id); err != nil {
			return domain.Invoice{}, err
		}
	}
	return s.invoiceByID(id)
}

func (s *Store) DeleteInvoice(id string) error {
	res, err := s.db.Exec(`DELETE FROM invoices WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
