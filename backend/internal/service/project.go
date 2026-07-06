package service

import (
	"fmt"
	"os"
	"path/filepath"
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

// Clone clones a git repository into path, then creates a project for the
// completed checkout. The DB row is not written until git clone succeeds.
func (svc *ProjectService) Clone(wsID, name, path, repo string) (domain.Project, error) {
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
	project, err := svc.store.CreateProject(wsID, name, path, repo)
	if err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, err
	}
	return project, nil
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
