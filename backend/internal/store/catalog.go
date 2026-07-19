package store

import "devdeck/backend/internal/domain"

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
// are returned without their nested project trees: the Projects list is the
// authoritative, machine-scoped set, and leaving both populated would ship
// other machines' projects inside the workspace tree.
func (s *Store) CatalogForMachine(machineID string) (domain.CatalogSnapshot, error) {
	workspaces, err := s.Workspaces()
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	for i := range workspaces {
		workspaces[i].Projects = nil
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
