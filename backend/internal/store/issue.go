package store

import (
	"database/sql"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func (s *Store) issuesOf(projectID string) ([]domain.Issue, error) {
	rows, err := s.db.Query(
		`SELECT id, project_id, title, description, status, priority, assignee, position, created_at, updated_at
		 FROM issues WHERE project_id = ? ORDER BY position ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Issue{}
	for rows.Next() {
		iss, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, iss)
	}
	return out, rows.Err()
}

func (s *Store) issueByID(id string) (domain.Issue, error) {
	row := s.db.QueryRow(
		`SELECT id, project_id, title, description, status, priority, assignee, position, created_at, updated_at
		 FROM issues WHERE id = ?`, id)
	iss, err := scanIssue(row)
	if err != nil {
		return domain.Issue{}, mapNotFound(err)
	}
	return iss, nil
}

func scanIssue(sc scanner) (domain.Issue, error) {
	var iss domain.Issue
	var assignee sql.NullString
	err := sc.Scan(&iss.ID, &iss.ProjectID, &iss.Title, &iss.Description, &iss.Status, &iss.Priority,
		&assignee, &iss.Position, &iss.CreatedAt, &iss.UpdatedAt)
	if err != nil {
		return iss, err
	}
	if assignee.Valid {
		a := assignee.String
		iss.Assignee = &a
	}
	return iss, nil
}

// CreateIssue creates an issue at the end of its status column (position =
// max existing position in that (project, status) pair + 1, or 0 if empty).
func (s *Store) CreateIssue(projectID, title, status, createdAt string) (domain.Issue, error) {
	if _, err := s.ProjectByID(projectID); err != nil {
		return domain.Issue{}, err
	}
	if status == "" {
		status = "todo"
	}
	var maxPos sql.NullFloat64
	if err := s.db.QueryRow(
		`SELECT MAX(position) FROM issues WHERE project_id = ? AND status = ?`, projectID, status,
	).Scan(&maxPos); err != nil {
		return domain.Issue{}, err
	}
	position := 0.0
	if maxPos.Valid {
		position = maxPos.Float64 + 1
	}
	id := idGen("is-")
	if _, err := s.db.Exec(
		`INSERT INTO issues (id, project_id, title, description, status, priority, assignee, position, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, 'normal', NULL, ?, ?, ?)`,
		id, projectID, title, status, position, createdAt, createdAt,
	); err != nil {
		return domain.Issue{}, err
	}
	return s.issueByID(id)
}

// UpdateIssue applies a partial patch. Status+Position together is how a
// kanban drag-and-drop move is expressed — the client computes both. Any
// tracked field (status, priority, assignee) that actually changes value
// gets an Activity timeline entry via recordIssueChangeEvents.
func (s *Store) UpdateIssue(id, updatedAt string, p port.IssuePatch) (domain.Issue, error) {
	before, err := s.issueByID(id)
	if err != nil {
		return domain.Issue{}, err
	}
	if err := firstErr(
		setStr(s.db, "issues", "title", id, p.Title),
		setStr(s.db, "issues", "description", id, p.Description),
		setStr(s.db, "issues", "status", id, p.Status),
		setStr(s.db, "issues", "priority", id, p.Priority),
	); err != nil {
		return domain.Issue{}, err
	}
	if p.Position != nil {
		if _, err := s.db.Exec(`UPDATE issues SET position = ? WHERE id = ?`, *p.Position, id); err != nil {
			return domain.Issue{}, err
		}
	}
	if p.HasAssignee {
		if _, err := s.db.Exec(`UPDATE issues SET assignee = ? WHERE id = ?`, p.Assignee, id); err != nil {
			return domain.Issue{}, err
		}
	}
	if _, err := s.db.Exec(`UPDATE issues SET updated_at = ? WHERE id = ?`, updatedAt, id); err != nil {
		return domain.Issue{}, err
	}
	if err := s.recordIssueChangeEvents(before, p, updatedAt); err != nil {
		return domain.Issue{}, err
	}
	return s.issueByID(id)
}

// recordIssueChangeEvents writes an Activity timeline entry for each tracked
// property patched to a value different from before — kanban moves, priority
// bumps, and reassignment all become visible in the issue's Activity feed.
func (s *Store) recordIssueChangeEvents(before domain.Issue, p port.IssuePatch, updatedAt string) error {
	if p.Status != nil && *p.Status != before.Status {
		from, to := before.Status, *p.Status
		if err := s.recordIssueEvent(before.ID, "status_changed", &from, &to, updatedAt); err != nil {
			return err
		}
	}
	if p.Priority != nil && *p.Priority != before.Priority {
		from, to := before.Priority, *p.Priority
		if err := s.recordIssueEvent(before.ID, "priority_changed", &from, &to, updatedAt); err != nil {
			return err
		}
	}
	if p.HasAssignee {
		beforeVal, afterVal := "", ""
		if before.Assignee != nil {
			beforeVal = *before.Assignee
		}
		if p.Assignee != nil {
			afterVal = *p.Assignee
		}
		if beforeVal != afterVal {
			var fromPtr, toPtr *string
			if beforeVal != "" {
				fromPtr = &beforeVal
			}
			if afterVal != "" {
				toPtr = &afterVal
			}
			if err := s.recordIssueEvent(before.ID, "assignee_changed", fromPtr, toPtr, updatedAt); err != nil {
				return err
			}
		}
	}
	return nil
}

// DeleteIssue deletes an issue.
func (s *Store) DeleteIssue(id string) error {
	res, err := s.db.Exec(`DELETE FROM issues WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
