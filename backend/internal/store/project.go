package store

import (
	"loom/backend/internal/domain"
)

// ── Child queries ──────────────────────────────────────────────────────────

func (s *Store) projectsOf(wsID string) ([]domain.Project, error) {
	rows, err := s.db.Query(`SELECT id, name, repo, path, expanded FROM projects WHERE workspace_id = ? ORDER BY rowid ASC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Repo, &p.Path, &p.Expanded); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		wts, err := s.worktreesOf(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Worktrees = wts
	}
	return out, nil
}

func (s *Store) ProjectByID(id string) (domain.Project, error) {
	var p domain.Project
	err := s.db.QueryRow(`SELECT id, name, repo, path, expanded FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Repo, &p.Path, &p.Expanded)
	if err != nil {
		return domain.Project{}, mapNotFound(err)
	}
	if p.Worktrees, err = s.worktreesOf(id); err != nil {
		return p, err
	}
	return p, nil
}

func (s *Store) projectWorkspaceID(projectID string) (string, error) {
	var wsID string
	err := s.db.QueryRow(`SELECT workspace_id FROM projects WHERE id = ?`, projectID).Scan(&wsID)
	if err != nil {
		return "", mapNotFound(err)
	}
	return wsID, err
}

// ── CRUD ───────────────────────────────────────────────────────────────────

// CreateProject creates a project under a workspace.
func (s *Store) CreateProject(wsID, name, path, repo string) (domain.Project, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Project{}, err
	}
	if !ok {
		return domain.Project{}, ErrNotFound
	}
	id := idGen("p-")
	_, err = s.db.Exec(`INSERT INTO projects (id, workspace_id, name, repo, path, expanded) VALUES (?, ?, ?, ?, ?, 1)`,
		id, wsID, name, repo, path)
	if err != nil {
		return domain.Project{}, err
	}
	return s.ProjectByID(id)
}

// UpdateProject patches a project's fields.
func (s *Store) UpdateProject(id string, name, path, repo *string, expanded *bool) (domain.Project, error) {
	if _, err := s.ProjectByID(id); err != nil {
		return domain.Project{}, err
	}
	if name != nil {
		if _, err := s.db.Exec(`UPDATE projects SET name = ? WHERE id = ?`, *name, id); err != nil {
			return domain.Project{}, err
		}
	}
	if path != nil {
		if _, err := s.db.Exec(`UPDATE projects SET path = ? WHERE id = ?`, *path, id); err != nil {
			return domain.Project{}, err
		}
	}
	if repo != nil {
		if _, err := s.db.Exec(`UPDATE projects SET repo = ? WHERE id = ?`, *repo, id); err != nil {
			return domain.Project{}, err
		}
	}
	if expanded != nil {
		if _, err := s.db.Exec(`UPDATE projects SET expanded = ? WHERE id = ?`, boolInt(*expanded), id); err != nil {
			return domain.Project{}, err
		}
	}
	return s.ProjectByID(id)
}

// DeleteProject deletes a project (cascades worktrees).
func (s *Store) DeleteProject(id string) error {
	res, err := s.db.Exec(`DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
