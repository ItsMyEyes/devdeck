package service

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
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
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "", "~/repo")
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

	matches, err := svc.Search(worktree.ID, `^src/.*\.(go|ts)$`, false)
	if err != nil {
		t.Fatal(err)
	}
	wantMatches := []string{"src/main.go", "src/new.ts"}
	if !reflect.DeepEqual(matches, wantMatches) {
		t.Fatalf("Search = %v, want %v", matches, wantMatches)
	}

	naturalMatches, err := svc.Search(worktree.ID, "src new", false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"src/new.ts"}; !reflect.DeepEqual(naturalMatches, want) {
		t.Fatalf("natural Search = %v, want %v", naturalMatches, want)
	}

	folderMatches, err := svc.Search(worktree.ID, "src", true)
	if err != nil {
		t.Fatal(err)
	}
	wantFolderMatches := []string{"src/", "src/new.ts", "src/main.go"}
	if !reflect.DeepEqual(folderMatches, wantFolderMatches) {
		t.Fatalf("folder Search = %v, want %v", folderMatches, wantFolderMatches)
	}

	invalidRegexMatches, err := svc.Search(worktree.ID, "[", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(invalidRegexMatches) != 0 {
		t.Fatalf("invalid-regex fallback Search = %v, want no matches", invalidRegexMatches)
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

func TestWorktreeFileServiceUploadDeleteManyAndArchive(t *testing.T) {
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	for _, dir := range []string{"docs", filepath.Join("src", "nested"), ".git"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("read me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "nested", "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("hidden"), 0o644); err != nil {
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

	svc := NewWorktreeFileService(st)
	uploaded, err := svc.Upload(worktree.ID, "docs", []WorktreeUploadFile{{Name: "note.txt", Reader: bytes.NewBufferString("hello")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(uploaded) != 1 || uploaded[0].Path != "docs/note.txt" {
		t.Fatalf("Upload = %+v, want docs/note.txt", uploaded)
	}
	if data, err := os.ReadFile(filepath.Join(root, "docs", "note.txt")); err != nil || string(data) != "hello" {
		t.Fatalf("uploaded file = %q, %v", data, err)
	}
	if _, err := svc.Upload(worktree.ID, "docs", []WorktreeUploadFile{{Name: "bad/name.txt", Reader: bytes.NewBuffer(nil)}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("unsafe upload name error = %v, want ErrValidation", err)
	}

	if err := svc.DeleteMany(worktree.ID, []string{"src", "src/nested/main.go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "src")); !os.IsNotExist(err) {
		t.Fatalf("src exists after DeleteMany: %v", err)
	}
	if err := svc.DeleteMany(worktree.ID, []string{""}); !errors.Is(err, ErrValidation) {
		t.Fatalf("root delete error = %v, want ErrValidation", err)
	}

	var archive bytes.Buffer
	if err := svc.Archive(worktree.ID, []string{"docs", "README.md"}, &archive); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(archive.Bytes()), int64(archive.Len()))
	if err != nil {
		t.Fatal(err)
	}
	contents := map[string]string{}
	for _, file := range zr.File {
		if file.FileInfo().IsDir() {
			contents[file.Name] = ""
			continue
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		contents[file.Name] = string(data)
	}
	if contents["README.md"] != "read me" || contents["docs/note.txt"] != "hello" {
		t.Fatalf("archive contents = %#v", contents)
	}
	if _, ok := contents["docs/"]; !ok {
		t.Fatalf("archive contents missing docs/: %#v", contents)
	}
	if err := svc.Archive(worktree.ID, []string{".git"}, &bytes.Buffer{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("reserved archive error = %v, want ErrValidation", err)
	}
}
