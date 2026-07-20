package service

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"devdeck/backend/internal/store"
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

	_, err = st.CreateProject(ws.ID, "core", repoPath, "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	branches, err := svc.ListBranches(repoPath)
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

	proj, err := svc.Clone(ws.ID, "", target, origin, "")
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

	if _, err := svc.Clone(ws.ID, "broken", target, missingOrigin, ""); err == nil {
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

func TestProjectCloneWithEmptyMachineIDStaysLocal(t *testing.T) {
	// This is the existing local-clone path, just calling Clone with the
	// new trailing machineID argument set to "" — must behave identically
	// to before this change.
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

	proj, err := svc.Clone(ws.ID, "", target, origin, "")
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if proj.MachineID != "" {
		t.Fatalf("MachineID = %q, want empty (local)", proj.MachineID)
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Fatalf("cloned README missing: %v", err)
	}
}

func TestProjectCloneWithMachineIDDispatchesToMachineAndPersistsIt(t *testing.T) {
	var gotRepo, gotPath string
	fakeMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotRepo, gotPath = body["repo"], body["path"]
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": gotPath})
	}))
	t.Cleanup(fakeMachine.Close)

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
	m, err := st.CreateMachine("builder", fakeMachine.URL, "rt-key", false)
	if err != nil {
		t.Fatal(err)
	}

	proj, err := svc.Clone(ws.ID, "myproj", "/home/dev/myproj", "https://github.com/org/repo.git", m.ID)
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if proj.MachineID != m.ID {
		t.Fatalf("MachineID = %q, want %q", proj.MachineID, m.ID)
	}
	if proj.Path != "/home/dev/myproj" {
		t.Fatalf("Path = %q, want /home/dev/myproj", proj.Path)
	}
	if gotRepo != "https://github.com/org/repo.git" || gotPath != "/home/dev/myproj" {
		t.Fatalf("machine received repo=%q path=%q", gotRepo, gotPath)
	}
	// The hub's own filesystem must NOT have been touched.
	if _, err := os.Stat("/home/dev/myproj"); !os.IsNotExist(err) {
		t.Fatalf("hub-local path should not exist, stat = %v", err)
	}
}

func TestProjectCloneWithMachineIDFailureDoesNotCreateProject(t *testing.T) {
	deadMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "clone destination already exists"})
	}))
	deadMachine.Close() // close immediately: guarantees an unreachable machine

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
	m, err := st.CreateMachine("builder", deadMachine.URL, "rt-key", false)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Clone(ws.ID, "myproj", "/home/dev/myproj", "https://github.com/org/repo.git", m.ID); err == nil {
		t.Fatal("Clone succeeded, want an error for an unreachable machine")
	}
	workspaces, err := st.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces[0].Projects) != 0 {
		t.Fatalf("projects = %#v, want none created on failure", workspaces[0].Projects)
	}
}

func TestProjectCloneWithMachineIDConflictReturnsErrConflict(t *testing.T) {
	// A destination-already-exists conflict reported by the machine must map
	// to ErrConflict (HTTP 409), the same status the local clone path uses
	// for the identical condition — not ErrValidation (HTTP 400).
	conflictMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "clone destination already exists"})
	}))
	t.Cleanup(conflictMachine.Close)

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
	m, err := st.CreateMachine("builder", conflictMachine.URL, "rt-key", false)
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Clone(ws.ID, "myproj", "/home/dev/myproj", "https://github.com/org/repo.git", m.ID)
	if err == nil {
		t.Fatal("Clone succeeded, want a conflict error")
	}
	if !errors.Is(err, ErrConflict) {
		t.Errorf("err = %v, want it to wrap ErrConflict", err)
	}
	if errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, must not also wrap ErrValidation", err)
	}
}

func TestRuntimeProjectServiceMarksCreatedProjectsLocal(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")

	svc := NewProjectServiceForRuntime(st)
	p, err := svc.Create(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "local" {
		t.Errorf("Origin after runtime-mode Create = %q, want local", p.Origin)
	}
}

func TestHubProjectServiceLeavesCreatedProjectsAsHub(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")

	svc := NewProjectService(st)
	p, err := svc.Create(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "hub" {
		t.Errorf("Origin after hub-mode Create = %q, want hub (unchanged control)", p.Origin)
	}
}
