package store

import (
	"database/sql"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const sshConnCols = `id, name, group_name, host, port, username, auth_type, jump_connection_id, executor_machine_id, host_key_fingerprint`

func scanSSHConnection(sc scanner) (domain.SSHConnection, error) {
	var c domain.SSHConnection
	var jump, executor, fingerprint sql.NullString
	err := sc.Scan(&c.ID, &c.Name, &c.Group, &c.Host, &c.Port, &c.Username, &c.AuthType, &jump, &executor, &fingerprint)
	if err != nil {
		return c, err
	}
	if jump.Valid {
		v := jump.String
		c.JumpConnectionID = &v
	}
	if executor.Valid {
		v := executor.String
		c.ExecutorMachineID = &v
	}
	if fingerprint.Valid {
		v := fingerprint.String
		c.HostKeyFingerprint = &v
	}
	return c, nil
}

// SSHConnections returns all saved SSH connections, most recently created first.
func (s *Store) SSHConnections() ([]domain.SSHConnection, error) {
	rows, err := s.db.Query(`SELECT ` + sshConnCols + ` FROM ssh_connections ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SSHConnection{}
	for rows.Next() {
		c, err := scanSSHConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SSHConnectionByID returns a single saved SSH connection.
func (s *Store) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	c, err := scanSSHConnection(s.db.QueryRow(`SELECT `+sshConnCols+` FROM ssh_connections WHERE id = ?`, id))
	if err != nil {
		return domain.SSHConnection{}, mapNotFound(err)
	}
	return c, nil
}

// CreateSSHConnection saves a new SSH connection (secrets are stored
// separately via UpsertSSHSecret).
func (s *Store) CreateSSHConnection(name, group, host string, portNum int, username, authType string, jumpConnectionID, executorMachineID *string) (domain.SSHConnection, error) {
	id := idGen("sc-")
	if _, err := s.db.Exec(`INSERT INTO ssh_connections (id, name, group_name, host, port, username, auth_type, jump_connection_id, executor_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, group, host, portNum, username, authType, jumpConnectionID, executorMachineID); err != nil {
		return domain.SSHConnection{}, err
	}
	return s.SSHConnectionByID(id)
}

// UpdateSSHConnection applies a partial update. Changing the host to a
// different value also clears the pinned host-key fingerprint: a different
// host presents a different key, and a stale pin would hard-block every
// future connect. A patch that re-sends the SAME host (as the edit dialog
// does, since it always includes every field) must NOT disturb the pin —
// so this compares against the stored host rather than merely checking
// whether p.Host was provided.
func (s *Store) UpdateSSHConnection(id string, p port.SSHConnectionPatch) (domain.SSHConnection, error) {
	existing, err := s.SSHConnectionByID(id)
	if err != nil {
		return domain.SSHConnection{}, err
	}
	if err := firstErr(
		setStr(s.db, "ssh_connections", "name", id, p.Name),
		setStr(s.db, "ssh_connections", "group_name", id, p.Group),
		setStr(s.db, "ssh_connections", "host", id, p.Host),
		setInt(s.db, "ssh_connections", "port", id, p.Port),
		setStr(s.db, "ssh_connections", "username", id, p.Username),
		setStr(s.db, "ssh_connections", "auth_type", id, p.AuthType),
	); err != nil {
		return domain.SSHConnection{}, err
	}
	if p.Host != nil && *p.Host != existing.Host {
		if err := s.SetSSHHostKey(id, nil); err != nil {
			return domain.SSHConnection{}, err
		}
	}
	if p.HasJumpConnectionID {
		if _, err := s.db.Exec(`UPDATE ssh_connections SET jump_connection_id = ? WHERE id = ?`, p.JumpConnectionID, id); err != nil {
			return domain.SSHConnection{}, err
		}
	}
	if p.HasExecutorMachineID {
		if _, err := s.db.Exec(`UPDATE ssh_connections SET executor_machine_id = ? WHERE id = ?`, p.ExecutorMachineID, id); err != nil {
			return domain.SSHConnection{}, err
		}
	}
	return s.SSHConnectionByID(id)
}

// DeleteSSHConnection deletes a saved connection; its secrets cascade.
func (s *Store) DeleteSSHConnection(id string) error {
	res, err := s.db.Exec(`DELETE FROM ssh_connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetSSHHostKey pins (or, with nil, clears) a connection's TOFU host-key
// fingerprint.
func (s *Store) SetSSHHostKey(id string, fingerprint *string) error {
	res, err := s.db.Exec(`UPDATE ssh_connections SET host_key_fingerprint = ? WHERE id = ?`, fingerprint, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpsertSSHSecret stores (replacing any previous value) one encrypted
// credential for a connection. cipherText is the base64 blob produced by
// the service layer's AES-256-GCM encryption — never plaintext.
func (s *Store) UpsertSSHSecret(connectionID, kind, cipherText string) error {
	_, err := s.db.Exec(`INSERT INTO ssh_secrets (connection_id, kind, storage_kind, cipher_text)
		VALUES (?, ?, 'db', ?)
		ON CONFLICT(connection_id, kind) DO UPDATE SET cipher_text = excluded.cipher_text, storage_kind = 'db'`,
		connectionID, kind, cipherText)
	return err
}

// SSHSecret returns one stored credential row (still encrypted).
func (s *Store) SSHSecret(connectionID, kind string) (domain.SSHSecret, error) {
	var sec domain.SSHSecret
	var ref sql.NullString
	err := s.db.QueryRow(`SELECT connection_id, kind, storage_kind, cipher_text, keychain_ref FROM ssh_secrets WHERE connection_id = ? AND kind = ?`,
		connectionID, kind).Scan(&sec.ConnectionID, &sec.Kind, &sec.StorageKind, &sec.CipherText, &ref)
	if err != nil {
		return domain.SSHSecret{}, mapNotFound(err)
	}
	if ref.Valid {
		v := ref.String
		sec.KeychainRef = &v
	}
	return sec, nil
}
