package service

import (
	"fmt"
	"path/filepath"
	"strings"

	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/port"
)

const maxCommitMessageLen = 4096

// WorktreeGitService exposes source-control operations (status, diff, stage,
// commit, push, pull, log) rooted strictly inside one worktree. Paths coming
// from the client go through the same normalization as the file service, so
// they can never escape the worktree or be read as git flags.
type WorktreeGitService struct {
	store port.Store
}

func NewWorktreeGitService(s port.Store) *WorktreeGitService {
	return &WorktreeGitService{store: s}
}

// GitFileDiff is the unified diff of one path or commit.
type GitFileDiff struct {
	Path string `json:"path"`
	Diff string `json:"diff"`
}

func (svc *WorktreeGitService) Status(worktreeID string) (gitpkg.Status, error) {
	root, err := svc.root(worktreeID)
	if err != nil {
		return gitpkg.Status{}, err
	}
	status, err := gitpkg.WorktreeStatus(root)
	if err != nil {
		return gitpkg.Status{}, gitError(err)
	}
	return status, nil
}

func (svc *WorktreeGitService) Diff(worktreeID, relativePath string, staged, untracked bool) (GitFileDiff, error) {
	root, clean, err := svc.rootAndPath(worktreeID, relativePath)
	if err != nil {
		return GitFileDiff{}, err
	}
	diff, err := gitpkg.DiffFile(root, clean, staged, untracked)
	if err != nil {
		return GitFileDiff{}, gitError(err)
	}
	return GitFileDiff{Path: clean, Diff: diff}, nil
}

func (svc *WorktreeGitService) ShowCommit(worktreeID, hash string) (GitFileDiff, error) {
	root, err := svc.root(worktreeID)
	if err != nil {
		return GitFileDiff{}, err
	}
	patch, err := gitpkg.ShowCommit(root, hash)
	if err != nil {
		return GitFileDiff{}, gitError(err)
	}
	return GitFileDiff{Path: hash, Diff: patch}, nil
}

func (svc *WorktreeGitService) Stage(worktreeID string, paths []string) error {
	root, cleaned, err := svc.rootAndPaths(worktreeID, paths)
	if err != nil {
		return err
	}
	return gitError(gitpkg.Stage(root, cleaned))
}

func (svc *WorktreeGitService) Unstage(worktreeID string, paths []string) error {
	root, cleaned, err := svc.rootAndPaths(worktreeID, paths)
	if err != nil {
		return err
	}
	return gitError(gitpkg.Unstage(root, cleaned))
}

// Discard reverts unstaged changes for the given paths. Tracked files are
// restored from the index; untracked files are deleted, so this is the one
// destructive git operation — the client confirms before calling it.
func (svc *WorktreeGitService) Discard(worktreeID string, paths []string) error {
	root, cleaned, err := svc.rootAndPaths(worktreeID, paths)
	if err != nil {
		return err
	}
	status, err := gitpkg.WorktreeStatus(root)
	if err != nil {
		return gitError(err)
	}
	untrackedSet := make(map[string]bool)
	for _, file := range status.Files {
		if file.Worktree == "?" {
			untrackedSet[file.Path] = true
		}
	}
	tracked := make([]string, 0, len(cleaned))
	untracked := make([]string, 0, len(cleaned))
	for _, path := range cleaned {
		if untrackedSet[path] {
			untracked = append(untracked, path)
		} else {
			tracked = append(tracked, path)
		}
	}
	return gitError(gitpkg.Discard(root, tracked, untracked))
}

func (svc *WorktreeGitService) Commit(worktreeID, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("commit message is required: %w", ErrValidation)
	}
	if len(message) > maxCommitMessageLen {
		return fmt.Errorf("commit message is too long: %w", ErrValidation)
	}
	root, err := svc.root(worktreeID)
	if err != nil {
		return err
	}
	return gitError(gitpkg.CommitStaged(root, message))
}

func (svc *WorktreeGitService) Push(worktreeID string) error {
	root, err := svc.root(worktreeID)
	if err != nil {
		return err
	}
	_, err = gitpkg.Push(root)
	return gitError(err)
}

func (svc *WorktreeGitService) Pull(worktreeID string) error {
	root, err := svc.root(worktreeID)
	if err != nil {
		return err
	}
	_, err = gitpkg.Pull(root)
	return gitError(err)
}

func (svc *WorktreeGitService) Log(worktreeID string, limit int) ([]gitpkg.Commit, error) {
	root, err := svc.root(worktreeID)
	if err != nil {
		return nil, err
	}
	commits, err := gitpkg.Log(root, limit)
	if err != nil {
		return nil, gitError(err)
	}
	return commits, nil
}

func (svc *WorktreeGitService) root(worktreeID string) (string, error) {
	worktree, err := svc.store.WorktreeByID(worktreeID)
	if err != nil {
		return "", err
	}
	projectRoot := gitpkg.ExpandHome(worktree.Path)
	if worktree.Root {
		return projectRoot, nil
	}
	return filepath.Join(projectRoot, ".wt", worktreeID), nil
}

func (svc *WorktreeGitService) rootAndPath(worktreeID, relativePath string) (string, string, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return "", "", err
	}
	root, err := svc.root(worktreeID)
	if err != nil {
		return "", "", err
	}
	return root, clean, nil
}

func (svc *WorktreeGitService) rootAndPaths(worktreeID string, paths []string) (string, []string, error) {
	if len(paths) == 0 {
		return "", nil, fmt.Errorf("at least one path is required: %w", ErrValidation)
	}
	cleaned := make([]string, 0, len(paths))
	for _, raw := range paths {
		clean, err := normalizeRelativePath(raw, false)
		if err != nil {
			return "", nil, err
		}
		cleaned = append(cleaned, clean)
	}
	root, err := svc.root(worktreeID)
	if err != nil {
		return "", nil, err
	}
	return root, cleaned, nil
}

// gitError surfaces the git CLI message to the client as a 400 instead of an
// opaque 500 — stderr from git ("merge conflict", "no upstream", …) is the
// actionable part of the failure.
func gitError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", strings.TrimSpace(err.Error()), ErrValidation)
}
