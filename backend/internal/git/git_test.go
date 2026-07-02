package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initTestRepo creates a temporary git repository with an initial commit on
// "main" and returns its path.
func initTestRepo(t *testing.T) string {
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

func TestListBranchesOnFreshRepo(t *testing.T) {
	repo := initTestRepo(t)
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 1 || branches[0] != "main" {
		t.Errorf("ListBranches = %v, want [main]", branches)
	}
}

func TestListBranchesIncludesAdditionalBranches(t *testing.T) {
	repo := initTestRepo(t)
	runGit(t, repo, "branch", "feat/x")
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("ListBranches = %v, want 2 branches", branches)
	}
}

func TestAddWorktreeCreatesRealDirectoryAndBranch(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/new-thing", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if _, err := os.Stat(wtPath); err != nil {
		t.Errorf("expected worktree directory to exist: %v", err)
	}
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	found := false
	for _, b := range branches {
		if b == "feat/new-thing" {
			found = true
		}
	}
	if !found {
		t.Errorf("ListBranches = %v, want it to include feat/new-thing", branches)
	}
}

func TestAddWorktreeRejectsInvalidBranchName(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "--force", "main"); err == nil {
		t.Error("expected error for flag-like branch name, got nil")
	}
}

func TestRemoveWorktreeDeletesDirectory(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/removable", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := RemoveWorktree(repo, wtPath); err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("expected worktree directory to be gone, stat err = %v", err)
	}
}

func TestRemoveWorktreeDeletesDirtyDirectory(t *testing.T) {
	// Regression test: a worktree with modified or untracked files used to
	// make plain `git worktree remove` fail with "contains modified or
	// untracked files, use --force to delete it". Delete is already an
	// explicit, deliberate user action (see the Kill→Delete consolidation),
	// so any uncommitted work in the worktree must not block it.
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/dirty", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wtPath, "untracked.txt"), []byte("scratch"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wtPath, "README.md"), []byte("modified"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := RemoveWorktree(repo, wtPath); err != nil {
		t.Fatalf("RemoveWorktree on a dirty worktree: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("expected dirty worktree directory to be gone, stat err = %v", err)
	}
}

func TestRemoveWorktreeIsIdempotent(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "never-created")
	if err := RemoveWorktree(repo, wtPath); err != nil {
		t.Errorf("RemoveWorktree on unregistered path should be a no-op, got: %v", err)
	}
}

func TestCheckoutSwitchesToExistingBranch(t *testing.T) {
	repo := initTestRepo(t)
	runGit(t, repo, "branch", "feat/target")
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/start", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := Checkout(wtPath, "feat/target"); err != nil {
		t.Fatalf("Checkout: %v", err)
	}
	current := strings.TrimSpace(mustRunGit(t, wtPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if current != "feat/target" {
		t.Errorf("current branch = %q, want feat/target", current)
	}
}

func TestCheckoutFailsWhenBranchAlreadyCheckedOutElsewhere(t *testing.T) {
	repo := initTestRepo(t)
	wtA := filepath.Join(t.TempDir(), "wtA")
	wtB := filepath.Join(t.TempDir(), "wtB")
	if err := AddWorktree(repo, wtA, "feat/a", "main"); err != nil {
		t.Fatalf("AddWorktree A: %v", err)
	}
	if err := AddWorktree(repo, wtB, "feat/b", "main"); err != nil {
		t.Fatalf("AddWorktree B: %v", err)
	}
	// feat/b is already checked out at wtB — checking it out at wtA must fail,
	// proving real git enforces the one-worktree-per-branch constraint.
	if err := Checkout(wtA, "feat/b"); err == nil {
		t.Error("expected Checkout to fail for a branch already checked out elsewhere, got nil")
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

func TestListBranchesExpandsTildeRepoPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	repoDir := filepath.Join(home, "code", "core")
	if err := os.MkdirAll(repoDir, 0755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoDir, "init", "-b", "main")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoDir, "add", "README.md")
	runGit(t, repoDir, "commit", "-m", "initial")

	branches, err := ListBranches("~/code/core")
	if err != nil {
		t.Fatalf("ListBranches with tilde path: %v", err)
	}
	if len(branches) != 1 || branches[0] != "main" {
		t.Errorf("ListBranches = %v, want [main]", branches)
	}
}

func TestValidRefRejectsFlagLikeNames(t *testing.T) {
	cases := map[string]bool{
		"main":          true,
		"feat/my-thing": true,
		"release-1.2":   true,
		"-x":            false,
		"--force":       false,
		"":               false,
		"has space":     false,
	}
	for name, want := range cases {
		if got := validRef(name); got != want {
			t.Errorf("validRef(%q) = %v, want %v", name, got, want)
		}
	}
}
