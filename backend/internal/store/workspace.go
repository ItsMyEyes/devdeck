package store

import (
	"database/sql"

	"loom/backend/internal/domain"
)

// ── Workspaces (full nested tree) ──────────────────────────────────────────

// Workspaces returns the full nested workspace tree, ordered by creation ASC.
func (s *Store) Workspaces() ([]domain.Workspace, error) {
	rows, err := s.db.Query(`SELECT id, name FROM workspaces ORDER BY rowid ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Workspace{}
	for rows.Next() {
		var w domain.Workspace
		if err := rows.Scan(&w.ID, &w.Name); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range out {
		ws := &out[i]
		projects, err := s.projectsOf(ws.ID)
		if err != nil {
			return nil, err
		}
		ws.Projects = projects
		if ws.News, err = s.newsOf(ws.ID); err != nil {
			return nil, err
		}
		if ws.Todos, err = s.todosOf(ws.ID); err != nil {
			return nil, err
		}
		if ws.Invoices, err = s.invoicesOf(ws.ID); err != nil {
			return nil, err
		}
		if ws.RecurringTemplates, err = s.recurringTemplatesOf(ws.ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ── Single-entity getters ──────────────────────────────────────────────────

func (s *Store) workspaceByID(id string) (domain.Workspace, error) {
	var ws domain.Workspace
	err := s.db.QueryRow(`SELECT id, name FROM workspaces WHERE id = ?`, id).Scan(&ws.ID, &ws.Name)
	if err == sql.ErrNoRows {
		return ws, ErrNotFound
	}
	if err != nil {
		return ws, err
	}
	if ws.Projects, err = s.projectsOf(id); err != nil {
		return ws, err
	}
	if ws.News, err = s.newsOf(id); err != nil {
		return ws, err
	}
	if ws.Todos, err = s.todosOf(id); err != nil {
		return ws, err
	}
	if ws.Invoices, err = s.invoicesOf(id); err != nil {
		return ws, err
	}
	if ws.RecurringTemplates, err = s.recurringTemplatesOf(id); err != nil {
		return ws, err
	}
	return ws, nil
}

func (s *Store) workspaceExists(id string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM workspaces WHERE id = ?`, id).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ── CRUD ───────────────────────────────────────────────────────────────────

// CreateWorkspace creates a new workspace with the given name.
func (s *Store) CreateWorkspace(name string) (domain.Workspace, error) {
	id := idGen("ws-")
	if _, err := s.db.Exec(`INSERT INTO workspaces (id, name) VALUES (?, ?)`, id, name); err != nil {
		return domain.Workspace{}, err
	}
	return s.workspaceByID(id)
}

// UpdateWorkspace renames a workspace.
func (s *Store) UpdateWorkspace(id string, name *string) (domain.Workspace, error) {
	if _, err := s.workspaceByID(id); err != nil {
		return domain.Workspace{}, err
	}
	if name != nil {
		if _, err := s.db.Exec(`UPDATE workspaces SET name = ? WHERE id = ?`, *name, id); err != nil {
			return domain.Workspace{}, err
		}
	}
	return s.workspaceByID(id)
}

// DeleteWorkspace deletes a workspace (cascades to projects, worktrees, etc.).
// If the deleted workspace was active, repoints to the first remaining one.
func (s *Store) DeleteWorkspace(id string) error {
	res, err := s.db.Exec(`DELETE FROM workspaces WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	set, err := s.Settings()
	if err != nil {
		return err
	}
	if set.ActiveWorkspaceID != nil && *set.ActiveWorkspaceID == id {
		var next sql.NullString
		if err := s.db.QueryRow(`SELECT id FROM workspaces ORDER BY rowid ASC LIMIT 1`).Scan(&next); err != nil && err != sql.ErrNoRows {
			return err
		}
		if next.Valid {
			return s.setActiveWorkspace(&next.String)
		}
		return s.setActiveWorkspace(nil)
	}
	return nil
}
