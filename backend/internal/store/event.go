package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
)

// ListIssueEvents returns an issue's auto-recorded timeline, oldest first.
func (s *Store) ListIssueEvents(issueID string) ([]domain.IssueEvent, error) {
	if _, err := s.issueByID(issueID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT id, issue_id, kind, from_value, to_value, created_at
		 FROM issue_events WHERE issue_id = ? ORDER BY created_at ASC`, issueID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.IssueEvent{}
	for rows.Next() {
		var e domain.IssueEvent
		var from, to sql.NullString
		if err := rows.Scan(&e.ID, &e.IssueID, &e.Kind, &from, &to, &e.CreatedAt); err != nil {
			return nil, err
		}
		if from.Valid {
			f := from.String
			e.FromValue = &f
		}
		if to.Valid {
			t := to.String
			e.ToValue = &t
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// recordIssueEvent inserts a single Activity timeline entry for a field
// change. Called from UpdateIssue — there's no public Create endpoint since
// events are always a side effect of an issue update, never authored directly.
func (s *Store) recordIssueEvent(issueID, kind string, from, to *string, createdAt string) error {
	id := idGen("ev-")
	_, err := s.db.Exec(
		`INSERT INTO issue_events (id, issue_id, kind, from_value, to_value, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, issueID, kind, from, to, createdAt,
	)
	return err
}
