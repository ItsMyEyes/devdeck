package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
)

// CreateIssueComment adds a comment to an issue's Activity timeline, or —
// when parentID is set — a single-level-deep reply to an existing comment.
func (s *Store) CreateIssueComment(issueID string, parentID *string, author, body, createdAt string) (domain.IssueComment, error) {
	if _, err := s.issueByID(issueID); err != nil {
		return domain.IssueComment{}, err
	}
	if parentID != nil {
		if _, err := s.issueCommentByID(*parentID); err != nil {
			return domain.IssueComment{}, err
		}
	}
	id := idGen("cm-")
	if _, err := s.db.Exec(
		`INSERT INTO issue_comments (id, issue_id, parent_id, author, body, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, issueID, parentID, author, body, createdAt, createdAt,
	); err != nil {
		return domain.IssueComment{}, err
	}
	return s.issueCommentByID(id)
}

// ListIssueComments returns every comment (and reply) on an issue, oldest
// first, so the client can group replies under their parent chronologically.
func (s *Store) ListIssueComments(issueID string) ([]domain.IssueComment, error) {
	if _, err := s.issueByID(issueID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT id, issue_id, parent_id, author, body, created_at, updated_at
		 FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC`, issueID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.IssueComment{}
	for rows.Next() {
		c, err := scanIssueComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateIssueComment edits a comment or reply's body.
func (s *Store) UpdateIssueComment(id, updatedAt, body string) (domain.IssueComment, error) {
	if _, err := s.issueCommentByID(id); err != nil {
		return domain.IssueComment{}, err
	}
	if _, err := s.db.Exec(`UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?`, body, updatedAt, id); err != nil {
		return domain.IssueComment{}, err
	}
	return s.issueCommentByID(id)
}

// DeleteIssueComment deletes a comment or reply. Deleting a root comment
// cascades to its replies via the parent_id foreign key.
func (s *Store) DeleteIssueComment(id string) error {
	res, err := s.db.Exec(`DELETE FROM issue_comments WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) issueCommentByID(id string) (domain.IssueComment, error) {
	row := s.db.QueryRow(
		`SELECT id, issue_id, parent_id, author, body, created_at, updated_at FROM issue_comments WHERE id = ?`, id,
	)
	c, err := scanIssueComment(row)
	if err != nil {
		return domain.IssueComment{}, mapNotFound(err)
	}
	return c, nil
}

func scanIssueComment(sc scanner) (domain.IssueComment, error) {
	var c domain.IssueComment
	var parentID sql.NullString
	err := sc.Scan(&c.ID, &c.IssueID, &parentID, &c.Author, &c.Body, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return c, err
	}
	if parentID.Valid {
		p := parentID.String
		c.ParentID = &p
	}
	return c, nil
}
