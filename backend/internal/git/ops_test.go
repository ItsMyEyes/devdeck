package git

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorktreeStatusReportsRepoForARealRepository(t *testing.T) {
	repo := initTestRepo(t)
	status, err := WorktreeStatus(repo)
	if err != nil {
		t.Fatalf("WorktreeStatus: %v", err)
	}
	if !status.Repo {
		t.Error("Repo = false for a real repository, want true")
	}
	if status.Branch != "main" {
		t.Errorf("Branch = %q, want main", status.Branch)
	}
}

func TestWorktreeStatusTreatsAPlainFolderAsNotARepo(t *testing.T) {
	// The regression this guards: a folder with no .git made the git panel
	// show git's "fatal: not a git repository" forever, with no way to create
	// one. It is an ordinary state, not an error.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}
	status, err := WorktreeStatus(dir)
	if err != nil {
		t.Fatalf("WorktreeStatus on a plain folder should not error: %v", err)
	}
	if status.Repo {
		t.Error("Repo = true for a folder with no .git, want false")
	}
	if len(status.Files) != 0 {
		t.Errorf("Files = %v, want empty", status.Files)
	}
}

func TestWorktreeStatusStillErrorsWhenTheDirectoryIsMissing(t *testing.T) {
	// A missing directory must not masquerade as "not a repo yet" — offering
	// to initialize one there would only fail again.
	missing := filepath.Join(t.TempDir(), "gone")
	if _, err := WorktreeStatus(missing); err == nil {
		t.Error("expected an error for a missing directory, got nil")
	}
}

func TestInitRepoMakesTheFolderAWorkingRepository(t *testing.T) {
	dir := t.TempDir()
	if IsRepo(dir) {
		t.Fatal("fresh temp dir already reports as a repo")
	}
	if err := InitRepo(dir); err != nil {
		t.Fatalf("InitRepo: %v", err)
	}
	if !IsRepo(dir) {
		t.Error("IsRepo = false after InitRepo, want true")
	}
	status, err := WorktreeStatus(dir)
	if err != nil {
		t.Fatalf("WorktreeStatus after init: %v", err)
	}
	if !status.Repo {
		t.Error("Repo = false after InitRepo, want true")
	}
}

func TestInitRepoLeavesExistingFilesUntrackedRatherThanCommitted(t *testing.T) {
	// The empty state promises "nothing is staged or committed" — hold it to
	// that, so a user who clicks Initialize gets a clean slate to review.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := InitRepo(dir); err != nil {
		t.Fatalf("InitRepo: %v", err)
	}
	status, err := WorktreeStatus(dir)
	if err != nil {
		t.Fatalf("WorktreeStatus after init: %v", err)
	}
	if len(status.Files) != 1 || status.Files[0].Path != "notes.txt" || status.Files[0].Worktree != "?" {
		t.Errorf("Files = %+v, want notes.txt reported as untracked", status.Files)
	}
	if _, err := Log(dir, 10); err != nil {
		t.Fatalf("Log on a commitless repo: %v", err)
	}
}
