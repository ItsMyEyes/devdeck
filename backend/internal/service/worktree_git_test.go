package service

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"devdeck/backend/internal/store"
)

// gitTestWorktree wires a root worktree over a real on-disk folder, the same
// shape the client uses for a project opened straight from a directory.
func gitTestWorktree(t *testing.T) (*WorktreeGitService, string, string) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}

	db, err := store.Open(filepath.Join(base, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	workspace, err := st.CreateWorkspace("Workspace")
	if err != nil {
		t.Fatal(err)
	}
	project, err := st.CreateProject(workspace.ID, "Project", "~/repo", "", "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "", "~/repo")
	if err != nil {
		t.Fatal(err)
	}
	return NewWorktreeGitService(st), worktree.ID, root
}

func TestGitServiceStatusThenInitTurnsAPlainFolderIntoARepo(t *testing.T) {
	svc, worktreeID, root := gitTestWorktree(t)
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	// What the panel sees first: a successful status that says "no repo",
	// which is what drives the Initialize Repository empty state.
	before, err := svc.Status(worktreeID)
	if err != nil {
		t.Fatalf("Status before init: %v", err)
	}
	if before.Repo {
		t.Fatal("Repo = true before init, want false")
	}

	if err := svc.Init(worktreeID); err != nil {
		t.Fatalf("Init: %v", err)
	}

	after, err := svc.Status(worktreeID)
	if err != nil {
		t.Fatalf("Status after init: %v", err)
	}
	if !after.Repo {
		t.Error("Repo = false after init, want true")
	}
	if len(after.Files) != 1 || after.Files[0].Path != "notes.txt" {
		t.Errorf("Files = %+v, want the pre-existing notes.txt as a change", after.Files)
	}
	// History is reachable immediately: a commitless repo logs as empty, not
	// as an error the panel would have to render.
	commits, err := svc.Log(worktreeID, 10)
	if err != nil {
		t.Fatalf("Log on a freshly initialized repo: %v", err)
	}
	if len(commits) != 0 {
		t.Errorf("Log = %+v, want no commits", commits)
	}
}

func TestGitServiceInitRefusesAnExistingRepository(t *testing.T) {
	svc, worktreeID, _ := gitTestWorktree(t)
	if err := svc.Init(worktreeID); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	err := svc.Init(worktreeID)
	if err == nil {
		t.Fatal("second Init succeeded, want a validation error")
	}
	// ErrValidation is what maps to 400 rather than a 500 in the handler.
	if !errors.Is(err, ErrValidation) {
		t.Errorf("Init error = %v, want it to wrap ErrValidation", err)
	}
}
