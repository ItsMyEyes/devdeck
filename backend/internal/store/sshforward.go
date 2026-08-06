package store

import (
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const sshForwardCols = `id, connection_id, mode, bind_host, bind_port, target_host, target_port, label`

func scanSSHForward(sc scanner) (domain.SSHForward, error) {
	var f domain.SSHForward
	err := sc.Scan(&f.ID, &f.ConnectionID, &f.Mode, &f.BindHost, &f.BindPort, &f.TargetHost, &f.TargetPort, &f.Label)
	if err != nil {
		return f, err
	}
	return f, nil
}

// SSHForwards returns all saved forwarding rules for a connection, ordered
// by mode then bind port so the UI list is stable across reloads.
func (s *Store) SSHForwards(connectionID string) ([]domain.SSHForward, error) {
	rows, err := s.db.Query(`SELECT `+sshForwardCols+` FROM ssh_forwards WHERE connection_id = ? ORDER BY mode, bind_port`, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SSHForward{}
	for rows.Next() {
		f, err := scanSSHForward(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SSHForwardByID returns a single saved forwarding rule.
func (s *Store) SSHForwardByID(id string) (domain.SSHForward, error) {
	f, err := scanSSHForward(s.db.QueryRow(`SELECT `+sshForwardCols+` FROM ssh_forwards WHERE id = ?`, id))
	if err != nil {
		return domain.SSHForward{}, mapNotFound(err)
	}
	return f, nil
}

// CreateSSHForward saves a new port-forwarding rule on a connection.
func (s *Store) CreateSSHForward(connectionID, mode, bindHost string, bindPort int, targetHost string, targetPort int, label string) (domain.SSHForward, error) {
	id := idGen("sf-")
	if _, err := s.db.Exec(`INSERT INTO ssh_forwards (id, connection_id, mode, bind_host, bind_port, target_host, target_port, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, connectionID, mode, bindHost, bindPort, targetHost, targetPort, label); err != nil {
		return domain.SSHForward{}, err
	}
	return s.SSHForwardByID(id)
}

// UpdateSSHForward applies a partial update to a forwarding rule.
func (s *Store) UpdateSSHForward(id string, p port.SSHForwardPatch) (domain.SSHForward, error) {
	if err := firstErr(
		setStr(s.db, "ssh_forwards", "mode", id, p.Mode),
		setStr(s.db, "ssh_forwards", "bind_host", id, p.BindHost),
		setInt(s.db, "ssh_forwards", "bind_port", id, p.BindPort),
		setStr(s.db, "ssh_forwards", "target_host", id, p.TargetHost),
		setInt(s.db, "ssh_forwards", "target_port", id, p.TargetPort),
		setStr(s.db, "ssh_forwards", "label", id, p.Label),
	); err != nil {
		return domain.SSHForward{}, err
	}
	return s.SSHForwardByID(id)
}

// DeleteSSHForward deletes a saved forwarding rule.
func (s *Store) DeleteSSHForward(id string) error {
	res, err := s.db.Exec(`DELETE FROM ssh_forwards WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
