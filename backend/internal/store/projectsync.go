package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
)

// MarkProjectSynced flips a project from origin='local' back to 'hub' and
// clears any sync_error, after the hub has accepted a replay of it. This
// must happen before the sync loop's next pull applies a fresh snapshot in
// the same cycle: ApplyCatalogSnapshot only deletes origin='hub' rows before
// reinserting, so a project still marked 'local' at that point would collide
// on its own primary key with the snapshot's copy of the same row.
func (s *Store) MarkProjectSynced(id string) error {
	_, err := s.db.Exec(`UPDATE projects SET origin = 'hub', sync_error = NULL WHERE id = ?`, id)
	return err
}

// SetProjectSyncError records why a local project's replay failed
// permanently (its workspace no longer exists on the hub), without changing
// origin — the row stays local and fully usable, just flagged so the
// operator knows it will never sync as-is.
func (s *Store) SetProjectSyncError(id, msg string) error {
	_, err := s.db.Exec(`UPDATE projects SET sync_error = ? WHERE id = ?`, msg, id)
	return err
}

// LocalProjects returns every project this runtime created while the hub was
// unreachable and has not yet successfully replayed.
func (s *Store) LocalProjects() ([]domain.Project, error) {
	rows, err := s.db.Query(`SELECT id, workspace_id, name, repo, path, expanded, machine_id, origin, sync_error FROM projects WHERE origin = 'local' ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var syncError sql.NullString
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.Repo, &p.Path, &p.Expanded, &p.MachineID, &p.Origin, &syncError); err != nil {
			return nil, err
		}
		if syncError.Valid {
			v := syncError.String
			p.SyncError = &v
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
