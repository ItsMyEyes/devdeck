package store

import (
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func scanMachine(sc scanner) (domain.Machine, error) {
	var m domain.Machine
	err := sc.Scan(&m.ID, &m.Name, &m.URL, &m.Key)
	return m, err
}

// Machines returns all registered runtime machines, most recently created first.
func (s *Store) Machines() ([]domain.Machine, error) {
	rows, err := s.db.Query(`SELECT id, name, url, key FROM machines ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Machine{}
	for rows.Next() {
		m, err := scanMachine(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MachineByID returns a single registered machine, including its key.
func (s *Store) MachineByID(id string) (domain.Machine, error) {
	m, err := scanMachine(s.db.QueryRow(`SELECT id, name, url, key FROM machines WHERE id = ?`, id))
	if err != nil {
		return domain.Machine{}, mapNotFound(err)
	}
	return m, nil
}

// CreateMachine registers a new runtime machine.
func (s *Store) CreateMachine(name, url, key string) (domain.Machine, error) {
	id := idGen("m-")
	if _, err := s.db.Exec(`INSERT INTO machines (id, name, url, key) VALUES (?, ?, ?, ?)`, id, name, url, key); err != nil {
		return domain.Machine{}, err
	}
	return s.MachineByID(id)
}

// UpdateMachine applies a partial update to a registered machine.
func (s *Store) UpdateMachine(id string, p port.MachinePatch) (domain.Machine, error) {
	if _, err := s.MachineByID(id); err != nil {
		return domain.Machine{}, err
	}
	if err := firstErr(
		setStr(s.db, "machines", "name", id, p.Name),
		setStr(s.db, "machines", "url", id, p.URL),
		setStr(s.db, "machines", "key", id, p.Key),
	); err != nil {
		return domain.Machine{}, err
	}
	return s.MachineByID(id)
}

// DeleteMachine deletes a registered machine.
func (s *Store) DeleteMachine(id string) error {
	res, err := s.db.Exec(`DELETE FROM machines WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
