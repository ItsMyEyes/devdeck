package service

import (
	"os"
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
	svc := NewProjectService(st)

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

func TestProjectCloneClonesRepoThenCreatesProject(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	origin := mustInitGitRepo(t)
	target := filepath.Join(t.TempDir(), "checkout")

	proj, err := svc.Clone(ws.ID, "", target, origin)
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}

	if proj.Name != "checkout" {
		t.Fatalf("project name = %q, want %q", proj.Name, "checkout")
	}
	if proj.Path != target {
		t.Fatalf("project path = %q, want %q", proj.Path, target)
	}
	if proj.Repo != origin {
		t.Fatalf("project repo = %q, want %q", proj.Repo, origin)
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Fatalf("cloned README missing: %v", err)
	}
	if _, err := st.ProjectByID(proj.ID); err != nil {
		t.Fatalf("created project not persisted: %v", err)
	}
}

func TestProjectCloneFailureDoesNotCreateProjectOrLeaveTarget(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "checkout")
	missingOrigin := filepath.Join(t.TempDir(), "missing-origin")

	if _, err := svc.Clone(ws.ID, "broken", target, missingOrigin); err == nil {
		t.Fatal("Clone succeeded, want an error")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target stat = %v, want not exist", err)
	}

	workspaces, err := st.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 1 {
		t.Fatalf("workspace count = %d, want 1", len(workspaces))
	}
	if len(workspaces[0].Projects) != 0 {
		t.Fatalf("projects = %#v, want none", workspaces[0].Projects)
	}
}
