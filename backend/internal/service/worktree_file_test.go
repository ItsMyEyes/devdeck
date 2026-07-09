package service

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"loom/backend/internal/store"
)

func TestWorktreeFileServiceCRUDAndRegexSearch(t *testing.T) {
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("read me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("hidden"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("ignored"), 0o644); err != nil {
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
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}

	svc := NewWorktreeFileService(st)
	entries, err := svc.List(worktree.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	gotNames := make([]string, len(entries))
	for i, entry := range entries {
		gotNames[i] = entry.Name
	}
	wantNames := []string{"node_modules", "src", "README.md"}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("List names = %v, want %v", gotNames, wantNames)
	}

	written, err := svc.Write(worktree.ID, "src/new.ts", "export const value = 1\n")
	if err != nil {
		t.Fatal(err)
	}
	if written.Path != "src/new.ts" {
		t.Fatalf("Write path = %q", written.Path)
	}
	read, err := svc.Read(worktree.ID, "src/new.ts")
	if err != nil {
		t.Fatal(err)
	}
	if read.Content != written.Content {
		t.Fatalf("Read content = %q, want %q", read.Content, written.Content)
	}

	matches, err := svc.Search(worktree.ID, `^src/.*\.(go|ts)$`)
	if err != nil {
		t.Fatal(err)
	}
	wantMatches := []string{"src/main.go", "src/new.ts"}
	if !reflect.DeepEqual(matches, wantMatches) {
		t.Fatalf("Search = %v, want %v", matches, wantMatches)
	}

	if _, err := svc.Search(worktree.ID, "["); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid regex error = %v, want ErrValidation", err)
	}
	if _, err := svc.Read(worktree.ID, "../test.db"); !errors.Is(err, ErrValidation) {
		t.Fatalf("traversal error = %v, want ErrValidation", err)
	}
	if _, err := svc.Read(worktree.ID, `C:\Windows\system.ini`); !errors.Is(err, ErrValidation) {
		t.Fatalf("Windows absolute path error = %v, want ErrValidation", err)
	}

	if err := svc.Delete(worktree.ID, "src/new.ts"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Read(worktree.ID, "src/new.ts"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted file error = %v, want ErrNotFound", err)
	}
}
