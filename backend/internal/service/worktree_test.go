package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

func newTestSvc(t *testing.T, kill func(string) error) (*WorktreeService, port.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewWorktreeService(st, kill), st
}

// mustInitGitRepo creates a temporary git repository with an initial commit
// on "main" and returns its path, for tests that exercise real git
// operations through WorktreeService.
func mustInitGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-m", "initial")
	return dir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func mustCreateWorktree(t *testing.T, st port.Store) string {
	t.Helper()
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "root", "", "", "claude-sonnet-5", "claude", "", "/tmp/core")
	if err != nil {
		t.Fatal(err)
	}
	return wt.ID
}

func TestCreateDefaultsModelOnlyForBranchMode(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	root, err := svc.Create(proj.ID, repoPath, "root", "", "", "", "", "")
	if err != nil {
		t.Fatalf("Create (root): %v", err)
	}
	if root.Model != "" {
		t.Errorf("root mode Model = %q, want empty (no agent should be assumed)", root.Model)
	}

	branch, err := svc.Create(proj.ID, repoPath, "branch", "", "", "", "", "")
	if err != nil {
		t.Fatalf("Create (branch): %v", err)
	}
	if branch.Model != "claude-sonnet-5" {
		t.Errorf("branch mode Model = %q, want default %q", branch.Model, "claude-sonnet-5")
	}
}

func TestCreateBranchModeMakesRealWorktree(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := svc.Create(proj.ID, repoPath, "branch", "feat/real-thing", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)
	if _, err := os.Stat(wtPath); err != nil {
		t.Errorf("expected real worktree directory at %s: %v", wtPath, err)
	}
}

func TestCreateRejectsUnknownBaseBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Create(proj.ID, repoPath, "branch", "feat/x", "does-not-exist", "", "", "")
	if err == nil {
		t.Fatal("expected error for unknown base branch, got nil")
	}
}

func TestCreateRejectsBranchAlreadyUsedByAnotherWorktree(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(proj.ID, repoPath, "branch", "feat/taken", "main", "", "", ""); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	_, err = svc.Create(proj.ID, repoPath, "branch", "feat/taken", "main", "", "", "")
	if err == nil {
		t.Fatal("expected conflict error for a branch already used by another worktree, got nil")
	}
}

func TestCreateRollsBackRowWhenGitAddFails(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	// A plain branch named "feat/exists" that no worktree has checked out —
	// our conflict pre-check passes, but `git worktree add -b` itself must
	// fail because the branch name already exists.
	runGit(t, repoPath, "branch", "feat/exists")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	before, err := st.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Create(proj.ID, repoPath, "branch", "feat/exists", "main", "", "", "")
	if err == nil {
		t.Fatal("expected git worktree add to fail for a branch name that already exists, got nil")
	}
	after, err := st.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Worktrees) != len(before.Worktrees) {
		t.Errorf("expected DB row to be rolled back on git failure: before=%d worktrees, after=%d", len(before.Worktrees), len(after.Worktrees))
	}
}

func TestDeleteRemovesRealGitWorktreeDirectory(t *testing.T) {
	svc, st := newTestSvc(t, func(string) error { return nil })
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, repoPath, "branch", "feat/to-delete", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)

	if err := svc.Delete(wt.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("expected worktree directory to be removed, stat err = %v", err)
	}
	if _, err := st.WorktreeByID(wt.ID); err == nil {
		t.Error("expected worktree row to be removed after Delete")
	}
}

func TestDeleteKillsRunningAgentBeforeRemovingRow(t *testing.T) {
	var killedID string
	svc, st := newTestSvc(t, func(id string) error {
		killedID = id
		return nil
	})
	id := mustCreateWorktree(t, st)

	if err := svc.Delete(id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if killedID != id {
		t.Errorf("Delete did not call kill for the worktree being deleted: got %q, want %q", killedID, id)
	}
	if _, err := st.WorktreeByID(id); err == nil {
		t.Error("expected worktree row to be removed after Delete")
	}
}

func TestUpdateChecksOutExistingBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/other")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, repoPath, "branch", "feat/start", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := st.UpdateWorktree(wt.ID, port.WorktreePatch{State: strPtr("idle")}); err != nil {
		t.Fatalf("seed idle state: %v", err)
	}

	newBranch := "feat/other"
	updated, err := svc.Update(wt.ID, port.WorktreePatch{Branch: &newBranch})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Branch != "feat/other" {
		t.Errorf("Branch = %q, want feat/other", updated.Branch)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)
	current := strings.TrimSpace(mustRunGit(t, wtPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if current != "feat/other" {
		t.Errorf("real checked-out branch = %q, want feat/other", current)
	}
}

func TestUpdateRejectsBranchChangeWhileRunning(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/other")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, repoPath, "branch", "feat/start", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Create leaves the worktree in state "running" by default (see store.CreateWorktree).

	newBranch := "feat/other"
	if _, err := svc.Update(wt.ID, port.WorktreePatch{Branch: &newBranch}); err == nil {
		t.Fatal("expected error when changing branch while running, got nil")
	}
}

func TestUpdateRejectsConflictingBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := svc.Create(proj.ID, repoPath, "branch", "feat/a", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create a: %v", err)
	}
	b, err := svc.Create(proj.ID, repoPath, "branch", "feat/b", "main", "", "", "")
	if err != nil {
		t.Fatalf("Create b: %v", err)
	}
	if _, err := st.UpdateWorktree(a.ID, port.WorktreePatch{State: strPtr("idle")}); err != nil {
		t.Fatalf("seed idle state: %v", err)
	}

	takenBranch := b.Branch
	if _, err := svc.Update(a.ID, port.WorktreePatch{Branch: &takenBranch}); err == nil {
		t.Fatal("expected conflict error checking out a branch already used by another worktree, got nil")
	}
}

func mustRunGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}

func strPtr(s string) *string { return &s }
