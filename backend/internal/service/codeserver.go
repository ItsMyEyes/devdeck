package service

import (
	"fmt"
	"path/filepath"

	"loom/backend/internal/codeserver"
	"loom/backend/internal/port"
)

// CodeServerService resolves a worktree's working directory and manages its
// on-demand code-server instance, so the handler layer doesn't need to know
// about process lifecycle or worktree-path layout.
type CodeServerService struct {
	store   port.Store
	manager *codeserver.Manager
}

// NewCodeServerService creates a code-server service backed by manager.
func NewCodeServerService(s port.Store, manager *codeserver.Manager) *CodeServerService {
	return &CodeServerService{store: s, manager: manager}
}

// Start launches (or reuses) a code-server instance rooted at the worktree's
// directory and returns the URL to open it.
func (svc *CodeServerService) Start(worktreeID string) (string, error) {
	dir, err := svc.workDir(worktreeID)
	if err != nil {
		return "", err
	}
	return svc.start(worktreeID, dir)
}

// StartForProject launches (or reuses) a code-server instance rooted at a
// project's own directory, keyed by the project's ID. This lets a project's
// root be opened directly — without first spawning a root-mode worktree —
// since project and worktree IDs use distinct prefixes ("p-" vs "w-") and
// never collide as instance keys.
func (svc *CodeServerService) StartForProject(projectID string) (string, error) {
	proj, err := svc.store.ProjectByID(projectID)
	if err != nil {
		return "", err
	}
	return svc.start(projectID, proj.Path)
}

func (svc *CodeServerService) start(id, dir string) (string, error) {
	url, err := svc.manager.Start(id, dir)
	if err != nil {
		return "", fmt.Errorf("%v: %w", err, ErrValidation)
	}
	return url, nil
}

// Stop tears down a worktree's running code-server instance, if any.
func (svc *CodeServerService) Stop(worktreeID string) error {
	return svc.manager.Stop(worktreeID)
}

// Status reports whether a code-server instance is currently running for a
// worktree, and its URL if so.
func (svc *CodeServerService) Status(worktreeID string) (url string, running bool) {
	return svc.manager.Status(worktreeID)
}

// workDir mirrors the branch-mode path computation in
// terminal/server.go resolveCommand and WorktreeService.Delete: the project
// root for root-mode worktrees, or its .wt/<id> checkout for branch mode.
func (svc *CodeServerService) workDir(worktreeID string) (string, error) {
	wt, err := svc.store.WorktreeByID(worktreeID)
	if err != nil {
		return "", err
	}
	proj, err := svc.store.ProjectByID(wt.ProjectID)
	if err != nil {
		return "", err
	}
	if wt.Root {
		return proj.Path, nil
	}
	return filepath.Join(proj.Path, ".wt", worktreeID), nil
}
