package store

import (
	"database/sql"
	"errors"
	"time"

	"devdeck/backend/internal/domain"
)

// ProjectsByMachine returns every project bound to one machine, flat. Unlike
// projectsOf/ProjectByID (which nest inside a Workspace tree and therefore
// leave WorkspaceID unset), rows here carry WorkspaceID explicitly: they are
// shipped flattened, outside any Workspace, in CatalogSnapshot.
func (s *Store) ProjectsByMachine(machineID string) ([]domain.Project, error) {
	rows, err := s.db.Query(
		`SELECT id, workspace_id, name, repo, path, expanded, machine_id
		 FROM projects WHERE machine_id = ? ORDER BY rowid`, machineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var expanded int
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.Repo, &p.Path, &expanded, &p.MachineID); err != nil {
			return nil, err
		}
		p.Expanded = expanded != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

// SSHConnectionsByExecutor returns the connections this machine is
// responsible for dialing. Secrets are never included — they are
// runtime-owned and never travel from the hub.
func (s *Store) SSHConnectionsByExecutor(machineID string) ([]domain.SSHConnection, error) {
	rows, err := s.db.Query(
		`SELECT `+sshConnCols+` FROM ssh_connections WHERE executor_machine_id = ? ORDER BY rowid`, machineID)
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

// CatalogForMachine assembles one machine's slice of the catalog. Workspaces
// come from WorkspaceShells, not Workspaces: a runtime is execution-scoped
// and must never receive another field's worth of the operator's business
// data (news, todos, invoices, recurring templates) just for asking for its
// own project list. The Projects list is the authoritative, machine-scoped
// set, shipped flattened alongside the shells rather than nested inside them.
func (s *Store) CatalogForMachine(machineID string) (domain.CatalogSnapshot, error) {
	workspaces, err := s.WorkspaceShells()
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	projects, err := s.ProjectsByMachine(machineID)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	conns, err := s.SSHConnectionsByExecutor(machineID)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	return domain.CatalogSnapshot{Workspaces: workspaces, Projects: projects, SSHConnections: conns}, nil
}

// MarkProjectLocal flags a project as created on this runtime and not yet
// accepted by the hub, so snapshots leave it alone.
func (s *Store) MarkProjectLocal(id string) error {
	_, err := s.db.Exec(`UPDATE projects SET origin = 'local' WHERE id = ?`, id)
	return err
}

// ApplyCatalogSnapshot replaces this runtime's replica with snap, in a single
// transaction. Two invariants hold absolutely:
//
//   - Projects with origin='local' are never deleted. They exist only here
//     until the hub accepts them.
//   - Worktrees are never touched. A catalog row disappearing is cheap and
//     reversible; deleting an unpushed worktree is permanent loss. The two
//     must never be triggered by the same remote event, so orphaned
//     worktrees simply outlive their project row.
func (s *Store) ApplyCatalogSnapshot(snap domain.CatalogSnapshot, syncedAt time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM projects WHERE origin = 'hub'`); err != nil {
		return err
	}
	// TODO(phase-5): host_key_fingerprint is runtime-owned (TOFU is a
	// statement by the observer) and never sent by the hub, so this delete
	// drops any locally-pinned fingerprint. Closed when the fingerprint moves
	// to its own runtime-owned table.
	if _, err := tx.Exec(`DELETE FROM ssh_connections`); err != nil {
		return err
	}
	// Delete only workspaces no surviving project still points at.
	// projects.workspace_id is REFERENCES workspaces(id) ON DELETE CASCADE
	// (db.go), so a blanket "DELETE FROM workspaces" would cascade-delete any
	// origin='local' project whose workspace happens to be reinserted right
	// after — silently violating the "local projects are never deleted"
	// invariant this function exists to uphold. Restricting the delete to
	// workspaces with no remaining project (hub-origin ones were already
	// purged above, so only local ones can still reference a row here) keeps
	// that invariant intact while still fully replacing every workspace the
	// snapshot doesn't need to preserve.
	if _, err := tx.Exec(`DELETE FROM workspaces WHERE id NOT IN (SELECT DISTINCT workspace_id FROM projects)`); err != nil {
		return err
	}

	for _, ws := range snap.Workspaces {
		if _, err := tx.Exec(
			`INSERT INTO workspaces (id, name) VALUES (?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name`, ws.ID, ws.Name); err != nil {
			return err
		}
	}
	for _, p := range snap.Projects {
		// ON CONFLICT is defense in depth: a project just replayed to the hub
		// (Task 7's push step flips it to origin='hub' before this pull runs
		// in the same cycle) can still collide here if that flip's write
		// hasn't landed for any reason — a plain INSERT would then hit the
		// PRIMARY KEY constraint and roll back the whole snapshot. This is
		// deliberately unconditional (no WHERE clause on the conflict, unlike
		// ReplayLocalProject): a snapshot is always self-consistent data the
		// hub itself already vouches for, so there's no "wrong machine" case
		// to guard against here — just make repeated application safe.
		if _, err := tx.Exec(
			`INSERT INTO projects (id, workspace_id, name, repo, path, expanded, machine_id, origin)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'hub')
			 ON CONFLICT(id) DO UPDATE SET
			   workspace_id = excluded.workspace_id, name = excluded.name, repo = excluded.repo,
			   path = excluded.path, expanded = excluded.expanded, machine_id = excluded.machine_id,
			   origin = 'hub', sync_error = NULL`,
			p.ID, p.WorkspaceID, p.Name, p.Repo, p.Path, boolInt(p.Expanded), p.MachineID); err != nil {
			return err
		}
	}
	for _, c := range snap.SSHConnections {
		if _, err := tx.Exec(
			`INSERT INTO ssh_connections
			 (id, name, group_name, host, port, username, auth_type, jump_connection_id, executor_machine_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c.ID, c.Name, c.Group, c.Host, c.Port, c.Username, c.AuthType,
			c.JumpConnectionID, c.ExecutorMachineID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO sync_state (id, last_synced_at) VALUES (1, ?)
		 ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
		syncedAt.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplayLocalProject inserts a project a runtime created while the hub was
// unreachable. Two things are non-negotiable:
//
//   - The ID is preserved exactly as the caller supplied it, never reissued:
//     the runtime's own worktrees already point at it.
//   - machineID always comes from the authenticated caller (RequireMachineKey
//     in the handler layer), never from request content — mirrors
//     CatalogForMachine's "structurally cannot express another machine"
//     guarantee from Phase 2.
//
// Retrying the same id is a safe no-op, not a duplicate-row error: a runtime
// whose first response was lost in transit will retry on the next sync tick,
// and the hub may already have accepted it.
func (s *Store) ReplayLocalProject(id, wsID, name, path, repo, machineID string) (domain.Project, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Project{}, err
	}
	if !ok {
		return domain.Project{}, ErrNotFound
	}
	_, err = s.db.Exec(`
		INSERT INTO projects (id, workspace_id, name, repo, path, expanded, machine_id, origin)
		VALUES (?, ?, ?, ?, ?, 1, ?, 'hub')
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name, path = excluded.path, repo = excluded.repo
		WHERE machine_id = excluded.machine_id
	`, id, wsID, name, repo, path, machineID)
	if err != nil {
		return domain.Project{}, err
	}
	return s.ProjectByID(id)
}

// LastSyncedAt reports when a snapshot last applied cleanly. A nil result
// means never — which the UI must render distinctly from "no projects",
// since a wrong hub key otherwise looks exactly like an empty account.
func (s *Store) LastSyncedAt() (*time.Time, error) {
	var raw *string
	if err := s.db.QueryRow(`SELECT last_synced_at FROM sync_state WHERE id = 1`).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, err
	}
	return &at, nil
}
