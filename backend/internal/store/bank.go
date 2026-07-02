package store

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func scanBank(sc scanner) (domain.Bank, error) {
	var b domain.Bank
	err := sc.Scan(&b.ID, &b.BankName, &b.AccountName, &b.AccountNumber)
	return b, err
}

// Banks returns all saved bank presets, most recently created first.
func (s *Store) Banks() ([]domain.Bank, error) {
	rows, err := s.db.Query(`SELECT id, bank_name, account_name, account_number FROM banks ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Bank{}
	for rows.Next() {
		b, err := scanBank(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) bankByID(id string) (domain.Bank, error) {
	b, err := scanBank(s.db.QueryRow(`SELECT id, bank_name, account_name, account_number FROM banks WHERE id = ?`, id))
	if err != nil {
		return domain.Bank{}, mapNotFound(err)
	}
	return b, nil
}

// CreateBank creates a new bank preset.
func (s *Store) CreateBank(bankName, accountName, accountNumber string) (domain.Bank, error) {
	id := idGen("bk-")
	if _, err := s.db.Exec(`INSERT INTO banks (id, bank_name, account_name, account_number) VALUES (?, ?, ?, ?)`,
		id, bankName, accountName, accountNumber); err != nil {
		return domain.Bank{}, err
	}
	return s.bankByID(id)
}

// UpdateBank applies a partial update to a bank preset.
func (s *Store) UpdateBank(id string, p port.BankPatch) (domain.Bank, error) {
	if _, err := s.bankByID(id); err != nil {
		return domain.Bank{}, err
	}
	if err := firstErr(
		setStr(s.db, "banks", "bank_name", id, p.BankName),
		setStr(s.db, "banks", "account_name", id, p.AccountName),
		setStr(s.db, "banks", "account_number", id, p.AccountNumber),
	); err != nil {
		return domain.Bank{}, err
	}
	return s.bankByID(id)
}

// DeleteBank deletes a bank preset.
func (s *Store) DeleteBank(id string) error {
	res, err := s.db.Exec(`DELETE FROM banks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
