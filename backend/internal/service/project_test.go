package service

import (
	"path/filepath"
	"testing"

	"loom/backend/internal/store"
)

func TestProjectListBranchesReturnsRealBranches(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st, nil)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/x")

	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	branches, err := svc.ListBranches(proj.ID)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("ListBranches = %v, want 2 branches", branches)
	}
}
