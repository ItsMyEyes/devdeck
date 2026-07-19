package store

import (
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

func scanCompany(sc scanner) (domain.Company, error) {
	var c domain.Company
	err := sc.Scan(&c.ID, &c.Name, &c.ShortAddress)
	return c, err
}

// Companies returns all saved company presets, most recently created first.
func (s *Store) Companies() ([]domain.Company, error) {
	rows, err := s.db.Query(`SELECT id, name, short_address FROM companies ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Company{}
	for rows.Next() {
		c, err := scanCompany(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) companyByID(id string) (domain.Company, error) {
	c, err := scanCompany(s.db.QueryRow(`SELECT id, name, short_address FROM companies WHERE id = ?`, id))
	if err != nil {
		return domain.Company{}, mapNotFound(err)
	}
	return c, nil
}

// CreateCompany creates a new company preset.
func (s *Store) CreateCompany(name, shortAddress string) (domain.Company, error) {
	id := idGen("co-")
	if _, err := s.db.Exec(`INSERT INTO companies (id, name, short_address) VALUES (?, ?, ?)`, id, name, shortAddress); err != nil {
		return domain.Company{}, err
	}
	return s.companyByID(id)
}

// UpdateCompany applies a partial update to a company preset.
func (s *Store) UpdateCompany(id string, p port.CompanyPatch) (domain.Company, error) {
	if _, err := s.companyByID(id); err != nil {
		return domain.Company{}, err
	}
	if err := firstErr(
		setStr(s.db, "companies", "name", id, p.Name),
		setStr(s.db, "companies", "short_address", id, p.ShortAddress),
	); err != nil {
		return domain.Company{}, err
	}
	return s.companyByID(id)
}

// DeleteCompany deletes a company preset.
func (s *Store) DeleteCompany(id string) error {
	res, err := s.db.Exec(`DELETE FROM companies WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
