package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const dbConnCols = `id, name, group_name, engine, host, port, username, database_name, ssl_mode, executor_machine_id, tunnel_connection_id, is_production, server_cert_fingerprint`

func scanDBConnection(sc scanner) (domain.DBConnection, error) {
	var c domain.DBConnection
	var executor, tunnel, fingerprint sql.NullString
	err := sc.Scan(&c.ID, &c.Name, &c.Group, &c.Engine, &c.Host, &c.Port, &c.Username,
		&c.Database, &c.SSLMode, &executor, &tunnel, &c.IsProduction, &fingerprint)
	if err != nil {
		return c, err
	}
	if executor.Valid {
		v := executor.String
		c.ExecutorMachineID = &v
	}
	if tunnel.Valid {
		v := tunnel.String
		c.TunnelConnectionID = &v
	}
	if fingerprint.Valid {
		v := fingerprint.String
		c.ServerCertFingerprint = &v
	}
	return c, nil
}

// DBConnections returns all saved database connections, newest first.
func (s *Store) DBConnections() ([]domain.DBConnection, error) {
	rows, err := s.db.Query(`SELECT ` + dbConnCols + ` FROM db_connections ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DBConnection{}
	for rows.Next() {
		c, err := scanDBConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DBConnectionByID returns a single saved database connection.
func (s *Store) DBConnectionByID(id string) (domain.DBConnection, error) {
	c, err := scanDBConnection(s.db.QueryRow(`SELECT `+dbConnCols+` FROM db_connections WHERE id = ?`, id))
	if err != nil {
		return domain.DBConnection{}, mapNotFound(err)
	}
	return c, nil
}

// CreateDBConnection saves a new connection (secrets go through UpsertDBSecret).
func (s *Store) CreateDBConnection(name, group, engine, host string, portNum int, username, database, sslMode string, executorMachineID, tunnelConnectionID *string, isProduction bool) (domain.DBConnection, error) {
	id := idGen("dbc-")
	if _, err := s.db.Exec(`INSERT INTO db_connections (id, name, group_name, engine, host, port, username, database_name, ssl_mode, executor_machine_id, tunnel_connection_id, is_production) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, group, engine, host, portNum, username, database, sslMode, executorMachineID, tunnelConnectionID, isProduction); err != nil {
		return domain.DBConnection{}, err
	}
	return s.DBConnectionByID(id)
}

// UpdateDBConnection applies a partial update. Nil pointers are left alone;
// the Has* flags allow explicitly clearing the nullable reference columns.
func (s *Store) UpdateDBConnection(id string, p port.DBConnectionPatch) (domain.DBConnection, error) {
	if err := firstErr(
		setStr(s.db, "db_connections", "name", id, p.Name),
		setStr(s.db, "db_connections", "group_name", id, p.Group),
		setStr(s.db, "db_connections", "engine", id, p.Engine),
		setStr(s.db, "db_connections", "host", id, p.Host),
		setInt(s.db, "db_connections", "port", id, p.Port),
		setStr(s.db, "db_connections", "username", id, p.Username),
		setStr(s.db, "db_connections", "database_name", id, p.Database),
		setStr(s.db, "db_connections", "ssl_mode", id, p.SSLMode),
	); err != nil {
		return domain.DBConnection{}, err
	}
	if p.HasExecutorMachineID {
		if _, err := s.db.Exec(`UPDATE db_connections SET executor_machine_id = ? WHERE id = ?`, p.ExecutorMachineID, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	if p.HasTunnelConnectionID {
		if _, err := s.db.Exec(`UPDATE db_connections SET tunnel_connection_id = ? WHERE id = ?`, p.TunnelConnectionID, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	if p.IsProduction != nil {
		if _, err := s.db.Exec(`UPDATE db_connections SET is_production = ? WHERE id = ?`, *p.IsProduction, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	return s.DBConnectionByID(id)
}

// DeleteDBConnection removes a connection; secrets and saved queries cascade.
func (s *Store) DeleteDBConnection(id string) error {
	res, err := s.db.Exec(`DELETE FROM db_connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetDBServerCertFingerprint pins the TOFU server certificate fingerprint.
func (s *Store) SetDBServerCertFingerprint(id, fingerprint string) error {
	res, err := s.db.Exec(`UPDATE db_connections SET server_cert_fingerprint = ? WHERE id = ?`, fingerprint, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpsertDBSecret stores (or replaces) one encrypted credential for a connection.
func (s *Store) UpsertDBSecret(connectionID, kind, cipherText string) error {
	_, err := s.db.Exec(`INSERT INTO db_secrets (connection_id, kind, storage_kind, cipher_text) VALUES (?, ?, 'db', ?)
		ON CONFLICT(connection_id, kind) DO UPDATE SET cipher_text = excluded.cipher_text, storage_kind = 'db'`,
		connectionID, kind, cipherText)
	return err
}

// DBSecretRow returns one encrypted credential row.
func (s *Store) DBSecretRow(connectionID, kind string) (domain.DBSecret, error) {
	var sec domain.DBSecret
	var ref sql.NullString
	err := s.db.QueryRow(`SELECT connection_id, kind, storage_kind, cipher_text, keychain_ref FROM db_secrets WHERE connection_id = ? AND kind = ?`,
		connectionID, kind).Scan(&sec.ConnectionID, &sec.Kind, &sec.StorageKind, &sec.CipherText, &ref)
	if err != nil {
		return domain.DBSecret{}, mapNotFound(err)
	}
	if ref.Valid {
		v := ref.String
		sec.KeychainRef = &v
	}
	return sec, nil
}

// DeleteDBSecret removes one credential kind for a connection. Deleting a
// credential that was never stored is not an error — the caller's intent
// ("this connection should not have a password") is satisfied either way.
func (s *Store) DeleteDBSecret(connectionID, kind string) error {
	_, err := s.db.Exec(`DELETE FROM db_secrets WHERE connection_id = ? AND kind = ?`, connectionID, kind)
	return err
}

// DBSavedQueries returns a connection's saved SQL snippets, newest first.
func (s *Store) DBSavedQueries(connectionID string) ([]domain.DBSavedQuery, error) {
	rows, err := s.db.Query(`SELECT id, connection_id, name, sql_text, updated_at FROM db_saved_queries WHERE connection_id = ? ORDER BY rowid DESC`, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DBSavedQuery{}
	for rows.Next() {
		var q domain.DBSavedQuery
		if err := rows.Scan(&q.ID, &q.ConnectionID, &q.Name, &q.SQL, &q.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// CreateDBSavedQuery stores a new named SQL snippet.
func (s *Store) CreateDBSavedQuery(connectionID, name, sqlText, updatedAt string) (domain.DBSavedQuery, error) {
	id := idGen("dbq-")
	if _, err := s.db.Exec(`INSERT INTO db_saved_queries (id, connection_id, name, sql_text, updated_at) VALUES (?, ?, ?, ?, ?)`,
		id, connectionID, name, sqlText, updatedAt); err != nil {
		return domain.DBSavedQuery{}, err
	}
	return s.dbSavedQueryByID(id)
}

func (s *Store) dbSavedQueryByID(id string) (domain.DBSavedQuery, error) {
	var q domain.DBSavedQuery
	err := s.db.QueryRow(`SELECT id, connection_id, name, sql_text, updated_at FROM db_saved_queries WHERE id = ?`, id).
		Scan(&q.ID, &q.ConnectionID, &q.Name, &q.SQL, &q.UpdatedAt)
	if err != nil {
		return domain.DBSavedQuery{}, mapNotFound(err)
	}
	return q, nil
}

// UpdateDBSavedQuery applies a partial update and always bumps updated_at.
func (s *Store) UpdateDBSavedQuery(id, updatedAt string, p port.DBSavedQueryPatch) (domain.DBSavedQuery, error) {
	if err := firstErr(
		setStr(s.db, "db_saved_queries", "name", id, p.Name),
		setStr(s.db, "db_saved_queries", "sql_text", id, p.SQL),
	); err != nil {
		return domain.DBSavedQuery{}, err
	}
	if _, err := s.db.Exec(`UPDATE db_saved_queries SET updated_at = ? WHERE id = ?`, updatedAt, id); err != nil {
		return domain.DBSavedQuery{}, err
	}
	return s.dbSavedQueryByID(id)
}

// DeleteDBSavedQuery removes a saved SQL snippet.
func (s *Store) DeleteDBSavedQuery(id string) error {
	res, err := s.db.Exec(`DELETE FROM db_saved_queries WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
