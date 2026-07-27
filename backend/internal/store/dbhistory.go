package store

import (
	"devdeck/backend/internal/domain"
)

// dbHistoryMaxPerConnection bounds how much SQL editor history one connection
// retains. History is a convenience, not a record of account: an operator who
// runs statements all day would otherwise grow this table without limit, and
// the entries they actually reach for are the recent ones.
const dbHistoryMaxPerConnection = 200

const dbHistoryCols = `id, connection_id, sql_text, status, error, elapsed_ms, row_count, executed_at`

func scanDBQueryHistory(sc scanner) (domain.DBQueryHistoryEntry, error) {
	var e domain.DBQueryHistoryEntry
	err := sc.Scan(&e.ID, &e.ConnectionID, &e.SQL, &e.Status, &e.Error, &e.ElapsedMS, &e.RowCount, &e.ExecutedAt)
	return e, err
}

// AddDBQueryHistory records one SQL editor execution and prunes the
// connection back to its newest dbHistoryMaxPerConnection entries.
//
// errMsg must already be the redacted, client-facing message — never a raw
// driver error. See domain.DBQueryHistoryEntry.
func (s *Store) AddDBQueryHistory(connectionID, sqlText, status, errMsg string, elapsedMS int64, rowCount int, executedAt string) (domain.DBQueryHistoryEntry, error) {
	id := idGen("dbh-")
	if _, err := s.db.Exec(`INSERT INTO db_query_history (`+dbHistoryCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, connectionID, sqlText, status, errMsg, elapsedMS, rowCount, executedAt); err != nil {
		return domain.DBQueryHistoryEntry{}, err
	}
	// Scoped to this connection so one busy connection's overflow never evicts
	// another's history. rowid, not executed_at, is the ordering key: two
	// executions a millisecond apart carry the same ISO-8601 second.
	if _, err := s.db.Exec(`DELETE FROM db_query_history
		WHERE connection_id = ?
		  AND rowid NOT IN (
		    SELECT rowid FROM db_query_history WHERE connection_id = ? ORDER BY rowid DESC LIMIT ?
		  )`, connectionID, connectionID, dbHistoryMaxPerConnection); err != nil {
		return domain.DBQueryHistoryEntry{}, err
	}
	return s.dbQueryHistoryByID(id)
}

func (s *Store) dbQueryHistoryByID(id string) (domain.DBQueryHistoryEntry, error) {
	e, err := scanDBQueryHistory(s.db.QueryRow(`SELECT `+dbHistoryCols+` FROM db_query_history WHERE id = ?`, id))
	if err != nil {
		return domain.DBQueryHistoryEntry{}, mapNotFound(err)
	}
	return e, nil
}

// DBQueryHistory returns a connection's recorded executions, newest first.
// A non-positive limit means "as many as are retained".
func (s *Store) DBQueryHistory(connectionID string, limit int) ([]domain.DBQueryHistoryEntry, error) {
	if limit <= 0 {
		limit = dbHistoryMaxPerConnection
	}
	rows, err := s.db.Query(`SELECT `+dbHistoryCols+` FROM db_query_history WHERE connection_id = ? ORDER BY rowid DESC LIMIT ?`,
		connectionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DBQueryHistoryEntry{}
	for rows.Next() {
		e, err := scanDBQueryHistory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ClearDBQueryHistory removes every recorded execution for a connection.
// Clearing an already-empty history is not an error — the caller's intent
// ("this connection should have no history") is satisfied either way, the
// same reasoning as DeleteDBSecret.
func (s *Store) ClearDBQueryHistory(connectionID string) error {
	_, err := s.db.Exec(`DELETE FROM db_query_history WHERE connection_id = ?`, connectionID)
	return err
}
