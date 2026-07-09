package service

import (
	"fmt"
	"path/filepath"
	"strings"

	"loom/backend/internal/domain"
	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/port"
)

// WorktreeService wraps worktree operations with business logic.
type WorktreeService struct {
	store port.Store
	// kill terminates the background agent process for a session, if one is
	// running. It must be idempotent (nil error when nothing is running).
	kill func(sessionID string) error
}

// NewWorktreeService creates a worktree service. kill is called to stop a
// worktree's background agent process on Kill/Delete; it's typically
// terminal.KillSession.
func NewWorktreeService(s port.Store, kill func(sessionID string) error) *WorktreeService {
	return &WorktreeService{store: s, kill: kill}
}

// Create creates a worktree. Branch mode always spawns an agent, so an empty
// model defaults to "claude-sonnet-5" and an empty agent defaults to
// "claude". Root mode is a plain shell terminal — an empty model/agent there
// must stay empty, or resolveCommand would treat it as an agent session (see
// backend/internal/terminal/server.go resolveCommand).
//
// Branch mode performs a real git worktree checkout: it validates base
// exists in the repository, rejects a branch already used by another
// worktree in the project, creates the DB row, then runs `git worktree add`.
// If the git command fails, the DB row is rolled back so the database never
// points at a worktree that doesn't exist on disk.
func (svc *WorktreeService) Create(projectID, path, mode, branch, base, model, agent, task string) (domain.Worktree, error) {
	branch = strings.TrimSpace(branch)
	base = strings.TrimSpace(base)
	model = strings.TrimSpace(model)
	agent = strings.TrimSpace(agent)
	path = gitpkg.ExpandHome(strings.TrimSpace(path))
	if mode == "branch" {
		if model == "" {
			model = "claude-sonnet-5"
		}
		if agent == "" {
			agent = "claude"
		}
	}
	if mode != "branch" {
		return svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task, path)
	}

	if base == "" {
		base = "main"
	}
	branches, err := gitpkg.ListBranches(path)
	if err != nil {
		return domain.Worktree{}, fmt.Errorf("list branches: %w", err)
	}
	if !containsStr(branches, base) {
		return domain.Worktree{}, fmt.Errorf("base branch %q not found in repository: %w", base, ErrValidation)
	}
	if branch != "" {
		siblings, err := svc.store.WorktreesByProjectID(projectID)
		if err != nil {
			return domain.Worktree{}, err
		}
		for _, w := range siblings {
			if w.Branch == branch {
				return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", branch, ErrConflict)
			}
		}
	}

	wt, err := svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task, path)
	if err != nil {
		return domain.Worktree{}, err
	}

	worktreePath := filepath.Join(path, ".wt", wt.ID)
	if err := gitpkg.AddWorktree(path, worktreePath, wt.Branch, base); err != nil {
		_ = svc.store.DeleteWorktree(wt.ID)
		return domain.Worktree{}, fmt.Errorf("git worktree add: %w", err)
	}
	return wt, nil
}

func containsStr(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// Update patches a worktree's fields. If Branch is set and differs from the
// worktree's current branch, this performs a real git checkout: it blocks
// while the worktree is running/waiting (pause first), rejects a branch
// already checked out by another worktree in the project, then runs
// `git checkout` before persisting the new branch value.
func (svc *WorktreeService) Update(id string, p port.WorktreePatch) (domain.Worktree, error) {
	if p.Branch != nil {
		wt, err := svc.store.WorktreeByID(id)
		if err != nil {
			return domain.Worktree{}, err
		}
		newBranch := strings.TrimSpace(*p.Branch)
		if newBranch != "" && newBranch != wt.Branch {
			if wt.State == "running" || wt.State == "waiting" {
				return domain.Worktree{}, fmt.Errorf("pause the worktree before changing its branch: %w", ErrConflict)
			}
			siblings, err := svc.store.WorktreesByProjectID(wt.ProjectID)
			if err != nil {
				return domain.Worktree{}, err
			}
			for _, sibling := range siblings {
				if sibling.ID != id && sibling.Branch == newBranch {
					return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", newBranch, ErrConflict)
				}
			}
			worktreePath := wt.Path
			if !wt.Root {
				worktreePath = filepath.Join(wt.Path, ".wt", id)
			}
			if err := gitpkg.Checkout(worktreePath, newBranch); err != nil {
				return domain.Worktree{}, fmt.Errorf("git checkout: %w", err)
			}
		}
	}
	return svc.store.UpdateWorktree(id, p)
}

// Delete stops the worktree's background agent (if running), removes its
// real git worktree checkout from disk (unless it's the project root), and
// deletes the DB row.
func (svc *WorktreeService) Delete(id string) error {
	wt, err := svc.store.WorktreeByID(id)
	if err != nil {
		return err
	}
	if svc.kill != nil {
		if err := svc.kill(id); err != nil {
			return err
		}
	}
	if !wt.Root {
		worktreePath := filepath.Join(wt.Path, ".wt", id)
		if err := gitpkg.RemoveWorktree(wt.Path, worktreePath); err != nil {
			return fmt.Errorf("git worktree remove: %w", err)
		}
	}
	return svc.store.DeleteWorktree(id)
}
