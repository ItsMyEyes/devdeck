package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"devdeck/backend/internal/domain"
	gitpkg "devdeck/backend/internal/git"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

// ProjectService wraps project operations with business logic.
type ProjectService struct {
	store   port.Store
	runtime bool
}

// NewProjectService creates a project service for the hub role.
func NewProjectService(s port.Store) *ProjectService {
	return &ProjectService{store: s}
}

// NewProjectServiceForRuntime creates a project service for the runtime
// role. Projects it creates are marked origin="local" until the sync loop
// replays them to the hub (see service.RunSyncLoop) — this is the only
// difference from the hub role's behavior.
func NewProjectServiceForRuntime(s port.Store) *ProjectService {
	return &ProjectService{store: s, runtime: true}
}

// Create creates a project under a workspace.
func (svc *ProjectService) Create(wsID, name, path, repo, machineID string) (domain.Project, error) {
	name = strings.TrimSpace(name)
	path = strings.TrimSpace(path)
	if name == "" {
		name = lastSegment(path)
	}
	if name == "" {
		name = "new-project"
	}
	if path == "" {
		path = "~/dev/" + name
	}
	p, err := svc.store.CreateProject(wsID, name, path, repo, machineID)
	if err != nil {
		return domain.Project{}, err
	}
	if svc.runtime {
		if err := svc.store.MarkProjectLocal(p.ID); err != nil {
			return domain.Project{}, err
		}
		p.Origin = "local"
	}
	return p, nil
}

// Clone clones a git repository into path, then creates a project for the
// completed checkout. The DB row is not written until the clone succeeds.
//
// If machineID is empty, the clone happens locally on the hub's own
// filesystem (this branch's behavior is unchanged from before machine
// dispatch existed). If machineID is set, the clone is dispatched to that
// machine via machineclient.CloneOnMachine instead — the hub's own
// filesystem is never touched in that case.
func (svc *ProjectService) Clone(wsID, name, path, repo, machineID string) (domain.Project, error) {
	name = strings.TrimSpace(name)
	path = strings.TrimSpace(path)
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return domain.Project{}, fmt.Errorf("github repository url is required: %w", ErrValidation)
	}
	if strings.ContainsAny(repo, "\x00\r\n") || strings.HasPrefix(repo, "-") {
		return domain.Project{}, fmt.Errorf("invalid repository url: %w", ErrValidation)
	}
	if path == "" {
		folder := repoFolderName(repo)
		if name != "" {
			folder = name
		}
		if folder == "" {
			return domain.Project{}, fmt.Errorf("clone destination is required: %w", ErrValidation)
		}
		path = "~/dev/" + folder
	}
	if strings.ContainsRune(path, '\x00') {
		return domain.Project{}, fmt.Errorf("invalid clone destination: %w", ErrValidation)
	}
	if name == "" {
		name = lastSegment(path)
	}
	if name == "" {
		name = repoFolderName(repo)
	}
	if name == "" {
		name = "new-project"
	}

	if machineID != "" {
		machine, err := svc.store.MachineByID(machineID)
		if err != nil {
			return domain.Project{}, err
		}
		if err := machineclient.CloneOnMachine(context.Background(), machine, repo, path); err != nil {
			if errors.Is(err, machineclient.ErrConflict) {
				return domain.Project{}, fmt.Errorf("clone destination already exists: %w", ErrConflict)
			}
			return domain.Project{}, fmt.Errorf("%s: %w", err.Error(), ErrValidation)
		}
		p, err := svc.store.CreateProject(wsID, name, path, repo, machineID)
		if err != nil {
			return domain.Project{}, err
		}
		if svc.runtime {
			if err := svc.store.MarkProjectLocal(p.ID); err != nil {
				return domain.Project{}, err
			}
			p.Origin = "local"
		}
		return p, nil
	}

	resolved := gitpkg.ExpandHome(path)
	if !filepath.IsAbs(resolved) {
		return domain.Project{}, fmt.Errorf("clone destination must be an absolute path or start with ~: %w", ErrValidation)
	}
	parent := filepath.Dir(resolved)
	info, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			return domain.Project{}, fmt.Errorf("clone parent folder does not exist: %w", ErrValidation)
		}
		return domain.Project{}, fmt.Errorf("inspect clone parent folder: %w", ErrValidation)
	}
	if !info.IsDir() {
		return domain.Project{}, fmt.Errorf("clone parent is not a folder: %w", ErrValidation)
	}
	if _, err := os.Stat(resolved); err == nil {
		return domain.Project{}, fmt.Errorf("clone destination already exists: %w", ErrConflict)
	} else if !os.IsNotExist(err) {
		return domain.Project{}, fmt.Errorf("inspect clone destination: %w", ErrValidation)
	}

	if err := gitpkg.Clone(repo, path); err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, fmt.Errorf("%s: %w", err.Error(), ErrValidation)
	}
	project, err := svc.store.CreateProject(wsID, name, path, repo, "")
	if err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, err
	}
	if svc.runtime {
		if err := svc.store.MarkProjectLocal(project.ID); err != nil {
			return domain.Project{}, err
		}
		project.Origin = "local"
	}
	return project, nil
}

// Update patches a project's fields.
func (svc *ProjectService) Update(id string, name, path, repo, machineID *string, expanded *bool) (domain.Project, error) {
	return svc.store.UpdateProject(id, name, path, repo, machineID, expanded)
}

// Delete deletes a project and its worktrees. On a runtime, only a project
// that has never reached the hub (origin="local") may be deleted this way —
// removing something that never synced is purely local; once origin="hub",
// deletion must go through the hub instead.
func (svc *ProjectService) Delete(id string) error {
	if svc.runtime {
		p, err := svc.store.ProjectByID(id)
		if err != nil {
			return err
		}
		if p.Origin != "local" {
			return fmt.Errorf("cannot delete a hub-synced project from a runtime: %w", ErrForbidden)
		}
	}
	return svc.store.DeleteProject(id)
}

// ListBranches returns the real git branches of a repository at path.
func (svc *ProjectService) ListBranches(path string) ([]string, error) {
	return gitpkg.ListBranches(gitpkg.ExpandHome(path))
}

func lastSegment(p string) string {
	p = strings.TrimRight(p, "/")
	if idx := strings.LastIndexByte(p, '/'); idx >= 0 {
		return p[idx+1:]
	}
	return p
}

func repoFolderName(repo string) string {
	repo = strings.TrimSpace(repo)
	repo = strings.TrimRight(repo, "/")
	repo = strings.TrimSuffix(repo, ".git")
	if idx := strings.LastIndexAny(repo, "/:"); idx >= 0 {
		repo = repo[idx+1:]
	}
	repo = strings.TrimSpace(repo)
	if repo == "." || repo == ".." {
		return ""
	}
	return repo
}
