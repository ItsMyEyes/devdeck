package service

import (
	"strings"

	"loom/backend/internal/domain"
	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/port"
)

// ProjectService wraps project operations with business logic.
type ProjectService struct {
	store port.Store
}

// NewProjectService creates a project service.
func NewProjectService(s port.Store) *ProjectService {
	return &ProjectService{store: s}
}

// Create creates a project under a workspace.
func (svc *ProjectService) Create(wsID, name, path, repo string) (domain.Project, error) {
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
	return svc.store.CreateProject(wsID, name, path, repo)
}

// Update patches a project's fields.
func (svc *ProjectService) Update(id string, name, path, repo *string, expanded *bool) (domain.Project, error) {
	return svc.store.UpdateProject(id, name, path, repo, expanded)
}

// Delete deletes a project and its worktrees.
func (svc *ProjectService) Delete(id string) error {
	return svc.store.DeleteProject(id)
}

// ListBranches returns the real git branches of a project's repository.
func (svc *ProjectService) ListBranches(id string) ([]string, error) {
	p, err := svc.store.ProjectByID(id)
	if err != nil {
		return nil, err
	}
	return gitpkg.ListBranches(p.Path)
}

func lastSegment(p string) string {
	p = strings.TrimRight(p, "/")
	if idx := strings.LastIndexByte(p, '/'); idx >= 0 {
		return p[idx+1:]
	}
	return p
}
