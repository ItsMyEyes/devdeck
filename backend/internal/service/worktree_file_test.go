package service

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"devdeck/backend/internal/store"
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

// newGrepTestWorktree builds a worktree fixture with content for Grep tests:
// a TODO comment in src/main.go (mixed case), a TODO in README.md, and a
// TODO inside node_modules/ + .git/ that must never appear in results
// (searchSkipDirs exclusion, same skip list filename Search already uses).
func newGrepTestWorktree(t *testing.T) (*WorktreeFileService, string) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	for _, dir := range []string{"src", ".git", filepath.Join("node_modules", "pkg")} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"src/main.go":               "func main() {\n\treturn nil\n}\n// TODO: cleanup this function\n",
		"README.md":                 "# Project\nTODO: write docs\n",
		".git/config":               "TODO: ignored\n",
		"node_modules/pkg/index.js": "TODO: ignored\n",
	}
	for relPath, content := range files {
		full := filepath.Join(root, filepath.FromSlash(relPath))
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
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
	return NewWorktreeFileService(st), worktree.ID
}

func TestWorktreeFileServiceGrepRequiresQuery(t *testing.T) {
	svc, worktreeID := newGrepTestWorktree(t)
	if _, err := svc.Grep(context.Background(), worktreeID, "   ", GrepOptions{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty query error = %v, want ErrValidation", err)
	}
}

// TestWorktreeFileServiceGrepReportsRgUnavailable covers rg missing in
// isolation from the grep fallback (which has its own dedicated tests
// below): resolveGrepBinary is stubbed out too so this test's expectations
// (RgAvailable: false, no results) don't depend on whether the machine
// running the suite happens to have a real `grep` on PATH.
func TestWorktreeFileServiceGrepReportsRgUnavailable(t *testing.T) {
	origRg := resolveRipgrep
	origGrep := resolveGrepBinary
	resolveRipgrep = func() (string, error) { return "", fmt.Errorf("not found") }
	resolveGrepBinary = func() (string, error) { return "", fmt.Errorf("not found") }
	defer func() { resolveRipgrep = origRg; resolveGrepBinary = origGrep }()

	svc, worktreeID := newGrepTestWorktree(t)
	result, err := svc.Grep(context.Background(), worktreeID, "TODO", GrepOptions{})
	if err != nil {
		t.Fatalf("Grep with rg unavailable: %v", err)
	}
	if result.RgAvailable {
		t.Error("RgAvailable = true, want false")
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want empty", result.Files)
	}
}

func TestWorktreeFileServiceGrepFindsLiteralMatchesCaseInsensitiveByDefault(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, worktreeID := newGrepTestWorktree(t)

	result, err := svc.Grep(context.Background(), worktreeID, "todo", GrepOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.RgAvailable {
		t.Fatal("RgAvailable = false, want true")
	}
	if result.Engine != "ripgrep" {
		t.Errorf("Engine = %q, want ripgrep", result.Engine)
	}
	got := map[string]int{}
	for _, f := range result.Files {
		got[f.Path] = len(f.Matches)
	}
	want := map[string]int{"src/main.go": 1, "README.md": 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Grep files = %v, want %v (node_modules/.git must be excluded)", got, want)
	}
	readme := result.Files[indexOfGrepFile(result.Files, "README.md")]
	if readme.Matches[0].Line != 2 {
		t.Errorf("README.md match line = %d, want 2", readme.Matches[0].Line)
	}
	if readme.Matches[0].Text != "TODO: write docs" {
		t.Errorf("README.md match text = %q, want %q", readme.Matches[0].Text, "TODO: write docs")
	}
}

func TestWorktreeFileServiceGrepCaseSensitive(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, worktreeID := newGrepTestWorktree(t)

	result, err := svc.Grep(context.Background(), worktreeID, "todo", GrepOptions{CaseSensitive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 0 {
		t.Fatalf("case-sensitive lowercase query files = %v, want none (source text is uppercase TODO)", result.Files)
	}

	result, err = svc.Grep(context.Background(), worktreeID, "TODO", GrepOptions{CaseSensitive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 2 {
		t.Fatalf("case-sensitive uppercase query files = %v, want 2 files", result.Files)
	}
}

func TestWorktreeFileServiceGrepRegexModeAndInvalidRegex(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, worktreeID := newGrepTestWorktree(t)

	literal, err := svc.Grep(context.Background(), worktreeID, "TODO:.*docs", GrepOptions{Regex: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(literal.Files) != 0 {
		t.Fatalf("literal mode treated %q as a regex: files = %v", "TODO:.*docs", literal.Files)
	}

	asRegex, err := svc.Grep(context.Background(), worktreeID, "TODO:.*docs", GrepOptions{Regex: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(asRegex.Files) != 1 || asRegex.Files[0].Path != "README.md" {
		t.Fatalf("regex mode files = %v, want just README.md", asRegex.Files)
	}

	if _, err := svc.Grep(context.Background(), worktreeID, "(unclosed", GrepOptions{Regex: true}); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid regex error = %v, want ErrValidation", err)
	}
}

func TestWorktreeFileServiceGrepIncludePattern(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, worktreeID := newGrepTestWorktree(t)

	result, err := svc.Grep(context.Background(), worktreeID, "TODO", GrepOptions{IncludePattern: "*.md"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].Path != "README.md" {
		t.Fatalf("includePattern *.md files = %v, want just README.md", result.Files)
	}
}

// TestWorktreeFileServiceGrepFallsBackToGrepWhenRgUnavailable proves the
// grep fallback (used when ripgrep isn't installed, on any non-Windows OS)
// produces the same GrepResult shape as the ripgrep path, sourced from
// grep's plain-text "path:line:text" output instead of `rg --json`.
func TestWorktreeFileServiceGrepFallsBackToGrepWhenRgUnavailable(t *testing.T) {
	skipIfMissing(t, "grep")
	origRg := resolveRipgrep
	resolveRipgrep = func() (string, error) { return "", fmt.Errorf("not found") }
	defer func() { resolveRipgrep = origRg }()

	svc, worktreeID := newGrepTestWorktree(t)

	result, err := svc.Grep(context.Background(), worktreeID, "todo", GrepOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.RgAvailable {
		t.Error("RgAvailable = true, want false (falling back to grep still means rg itself isn't installed)")
	}
	if result.Engine != "grep" {
		t.Errorf("Engine = %q, want grep", result.Engine)
	}
	got := map[string]int{}
	for _, f := range result.Files {
		got[f.Path] = len(f.Matches)
	}
	want := map[string]int{"src/main.go": 1, "README.md": 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("grep fallback files = %v, want %v (node_modules/.git must be excluded)", got, want)
	}
	readme := result.Files[indexOfGrepFile(result.Files, "README.md")]
	if readme.Matches[0].Line != 2 {
		t.Errorf("README.md match line = %d, want 2", readme.Matches[0].Line)
	}
	if readme.Matches[0].Text != "TODO: write docs" {
		t.Errorf("README.md match text = %q, want %q", readme.Matches[0].Text, "TODO: write docs")
	}
	if readme.Matches[0].Column != 0 {
		t.Errorf("README.md match column = %d, want 0 (grep doesn't report a match column)", readme.Matches[0].Column)
	}
}

// TestWorktreeFileServiceGrepSkipsGrepFallbackOnWindows covers design
// decision 5: Windows has no reliable built-in grep, so when rg is missing
// on Windows, Grep must not even attempt the grep fallback — it should
// report RgAvailable: false immediately without calling resolveGrepBinary.
func TestWorktreeFileServiceGrepSkipsGrepFallbackOnWindows(t *testing.T) {
	origRg := resolveRipgrep
	origGrep := resolveGrepBinary
	origGOOS := currentGOOS
	resolveRipgrep = func() (string, error) { return "", fmt.Errorf("not found") }
	grepCalled := false
	resolveGrepBinary = func() (string, error) { grepCalled = true; return "/usr/bin/grep", nil }
	currentGOOS = "windows"
	defer func() { resolveRipgrep = origRg; resolveGrepBinary = origGrep; currentGOOS = origGOOS }()

	svc, worktreeID := newGrepTestWorktree(t)
	result, err := svc.Grep(context.Background(), worktreeID, "TODO", GrepOptions{})
	if err != nil {
		t.Fatalf("Grep on windows without rg: %v", err)
	}
	if result.RgAvailable {
		t.Error("RgAvailable = true, want false")
	}
	if grepCalled {
		t.Error("resolveGrepBinary was called on windows — grep fallback must be skipped per design decision 5")
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want empty", result.Files)
	}
}

// TestWorktreeFileServiceGrepFallbackQueryWithShellMetacharactersHasNoSideEffects
// mirrors ssh_file_test.go's shell-injection test but for the local grep
// fallback path. os/exec.Command never invokes a shell — args are delivered
// to the grep process as an argv array — so this proves the metacharacters
// embedded in the query are treated as one inert literal argument rather
// than shell syntax, even though the malicious payload targets real files
// on disk (scoped to this test's own throwaway worktree root, never
// anything outside it).
func TestWorktreeFileServiceGrepFallbackQueryWithShellMetacharactersHasNoSideEffects(t *testing.T) {
	skipIfMissing(t, "grep")
	origRg := resolveRipgrep
	resolveRipgrep = func() (string, error) { return "", fmt.Errorf("not found") }
	defer func() { resolveRipgrep = origRg }()

	svc, worktreeID := newGrepTestWorktree(t)
	root, _, _, err := svc.resolve(worktreeID, "", true, false)
	if err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(root, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("do not delete me"), 0o644); err != nil {
		t.Fatal(err)
	}
	pwnedMarker := filepath.Join(root, "pwned.txt")

	dangerousQuery := "nope'; rm -rf " + sentinel + "; touch " + pwnedMarker + "; echo done #"

	result, err := svc.Grep(context.Background(), worktreeID, dangerousQuery, GrepOptions{})
	if err != nil {
		t.Fatalf("Grep with metacharacter-laden query via grep fallback: %v", err)
	}
	if result.Engine != "grep" {
		t.Fatalf("Engine = %q, want grep", result.Engine)
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want no matches (query is a literal string not present in any fixture file)", result.Files)
	}
	if data, statErr := os.ReadFile(sentinel); statErr != nil || string(data) != "do not delete me" {
		t.Fatalf("sentinel file = %q, %v, want unchanged %q — grep args must never be shell-interpreted", data, statErr, "do not delete me")
	}
	if _, statErr := os.Stat(pwnedMarker); statErr == nil {
		t.Fatal("pwned marker file was created — grep args must never be shell-interpreted")
	}
}

func indexOfGrepFile(files []GrepFileMatch, path string) int {
	for i, f := range files {
		if f.Path == path {
			return i
		}
	}
	return -1
}

func TestRgGrepArgsBuildsExpectedFlags(t *testing.T) {
	args := rgGrepArgs("needle", GrepOptions{Regex: false, CaseSensitive: false}, "/tmp/root")
	joined := strings.Join(args, " ")
	for _, want := range []string{"--json", "--fixed-strings", "--ignore-case", "--glob !.git", "--glob !node_modules"} {
		if !strings.Contains(joined, want) {
			t.Errorf("rgGrepArgs literal/case-insensitive = %q, missing %q", joined, want)
		}
	}
	if args[len(args)-2] != "needle" || args[len(args)-1] != "/tmp/root" {
		t.Errorf("rgGrepArgs final positional args = %v, want [needle /tmp/root]", args[len(args)-2:])
	}

	regexCaseSensitive := rgGrepArgs("needle", GrepOptions{Regex: true, CaseSensitive: true, IncludePattern: "*.go"}, "/tmp/root")
	joinedRC := strings.Join(regexCaseSensitive, " ")
	if strings.Contains(joinedRC, "--fixed-strings") {
		t.Errorf("rgGrepArgs regex mode still passed --fixed-strings: %q", joinedRC)
	}
	if !strings.Contains(joinedRC, "--case-sensitive") {
		t.Errorf("rgGrepArgs case-sensitive mode missing --case-sensitive: %q", joinedRC)
	}
	if !strings.Contains(joinedRC, "--glob *.go") {
		t.Errorf("rgGrepArgs includePattern missing --glob *.go: %q", joinedRC)
	}
}

func TestParseRipgrepJSONCapsFilesAndMatches(t *testing.T) {
	var buf bytes.Buffer
	for i := 0; i < maxGrepFiles+5; i++ {
		path := fmt.Sprintf("/root/file%03d.txt", i)
		buf.WriteString(fmt.Sprintf(
			`{"type":"match","data":{"path":{"text":%q},"lines":{"text":"needle\n"},"line_number":1,"submatches":[{"start":0}]}}`+"\n",
			path,
		))
	}
	files, truncated := parseRipgrepJSON(buf.Bytes(), "/root")
	if len(files) != maxGrepFiles {
		t.Fatalf("len(files) = %d, want %d (maxGrepFiles cap)", len(files), maxGrepFiles)
	}
	if !truncated {
		t.Error("truncated = false, want true (file count exceeded maxGrepFiles)")
	}
	if files[0].Path != "file000.txt" {
		t.Errorf("first file path = %q, want %q (rootPrefix stripped)", files[0].Path, "file000.txt")
	}

	var perFile bytes.Buffer
	for i := 0; i < maxGrepMatchesPerFile+3; i++ {
		perFile.WriteString(fmt.Sprintf(
			`{"type":"match","data":{"path":{"text":"/root/one.txt"},"lines":{"text":"needle\n"},"line_number":%d,"submatches":[{"start":2}]}}`+"\n",
			i+1,
		))
	}
	oneFile, truncatedMatches := parseRipgrepJSON(perFile.Bytes(), "/root")
	if len(oneFile) != 1 {
		t.Fatalf("len(files) = %d, want 1", len(oneFile))
	}
	if len(oneFile[0].Matches) != maxGrepMatchesPerFile {
		t.Fatalf("len(matches) = %d, want %d (maxGrepMatchesPerFile cap)", len(oneFile[0].Matches), maxGrepMatchesPerFile)
	}
	if !truncatedMatches {
		t.Error("truncated = false, want true (match count exceeded maxGrepMatchesPerFile)")
	}
	if oneFile[0].Matches[0].Column != 3 {
		t.Errorf("Column = %d, want 3 (submatch start 2, +1)", oneFile[0].Matches[0].Column)
	}
}

func TestGrepFallbackArgsBuildsExpectedFlags(t *testing.T) {
	args := grepFallbackArgs("needle", GrepOptions{Regex: false, CaseSensitive: false}, "/tmp/root")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-r", "-n", "-I", "-i", "-F", "--exclude-dir=.git", "--exclude-dir=node_modules"} {
		if !strings.Contains(joined, want) {
			t.Errorf("grepFallbackArgs literal/case-insensitive = %q, missing %q", joined, want)
		}
	}
	if args[len(args)-2] != "needle" || args[len(args)-1] != "/tmp/root" {
		t.Errorf("grepFallbackArgs final positional args = %v, want [needle /tmp/root]", args[len(args)-2:])
	}

	regexCaseSensitive := grepFallbackArgs("needle", GrepOptions{Regex: true, CaseSensitive: true}, "/tmp/root")
	joinedRC := strings.Join(regexCaseSensitive, " ")
	if strings.Contains(joinedRC, "-F") {
		t.Errorf("grepFallbackArgs regex mode still passed -F: %q", joinedRC)
	}
	if strings.Contains(joinedRC, "-i") {
		t.Errorf("grepFallbackArgs case-sensitive mode still passed -i: %q", joinedRC)
	}
}

// TestParseGrepOutputSplitsOnlyFirstTwoColons proves parseGrepOutput's
// SplitN(line, ":", 3) correctly preserves colons that appear inside the
// matched text (a very common case — URLs, "key: value" pairs, timestamps)
// by only treating the first two colons in a line as the path/line-number
// delimiters.
func TestParseGrepOutputSplitsOnlyFirstTwoColons(t *testing.T) {
	root := "/tmp/root"
	output := []byte(root + "/src/main.go:42:http://example.com: see docs\n")
	files, truncated := parseGrepOutput(output, root)
	if truncated {
		t.Fatal("truncated = true, want false")
	}
	if len(files) != 1 || files[0].Path != "src/main.go" {
		t.Fatalf("files = %v, want one entry for src/main.go (rootPrefix stripped)", files)
	}
	if len(files[0].Matches) != 1 {
		t.Fatalf("matches = %v, want 1", files[0].Matches)
	}
	m := files[0].Matches[0]
	if m.Line != 42 {
		t.Errorf("Line = %d, want 42", m.Line)
	}
	if m.Column != 0 {
		t.Errorf("Column = %d, want 0 (grep doesn't report a match column)", m.Column)
	}
	if m.Text != "http://example.com: see docs" {
		t.Errorf("Text = %q, want %q", m.Text, "http://example.com: see docs")
	}
}

func TestParseGrepOutputCapsFilesAndMatches(t *testing.T) {
	var buf bytes.Buffer
	for i := 0; i < maxGrepFiles+5; i++ {
		buf.WriteString(fmt.Sprintf("/root/file%03d.txt:1:needle\n", i))
	}
	files, truncated := parseGrepOutput(buf.Bytes(), "/root")
	if len(files) != maxGrepFiles {
		t.Fatalf("len(files) = %d, want %d (maxGrepFiles cap)", len(files), maxGrepFiles)
	}
	if !truncated {
		t.Error("truncated = false, want true (file count exceeded maxGrepFiles)")
	}
	if files[0].Path != "file000.txt" {
		t.Errorf("first file path = %q, want %q (rootPrefix stripped)", files[0].Path, "file000.txt")
	}

	var perFile bytes.Buffer
	for i := 0; i < maxGrepMatchesPerFile+3; i++ {
		perFile.WriteString(fmt.Sprintf("/root/one.txt:%d:needle\n", i+1))
	}
	oneFile, truncatedMatches := parseGrepOutput(perFile.Bytes(), "/root")
	if len(oneFile) != 1 {
		t.Fatalf("len(files) = %d, want 1", len(oneFile))
	}
	if len(oneFile[0].Matches) != maxGrepMatchesPerFile {
		t.Fatalf("len(matches) = %d, want %d (maxGrepMatchesPerFile cap)", len(oneFile[0].Matches), maxGrepMatchesPerFile)
	}
	if !truncatedMatches {
		t.Error("truncated = false, want true (match count exceeded maxGrepMatchesPerFile)")
	}
}

func TestWorktreeFileServiceInstallRipgrepReturnsVersionOnSuccess(t *testing.T) {
	origInstall := installRipgrepLocal
	origGOOS := currentGOOS
	origGOARCH := currentGOARCH
	currentGOOS = "linux"
	currentGOARCH = "arm64"
	var gotGOOS, gotGOARCH string
	installRipgrepLocal = func(ctx context.Context, goos, goarch string) (string, string, error) {
		gotGOOS, gotGOARCH = goos, goarch
		return "/home/user/.local/bin/rg", "15.2.0", nil
	}
	defer func() {
		installRipgrepLocal = origInstall
		currentGOOS = origGOOS
		currentGOARCH = origGOARCH
	}()

	svc, worktreeID := newGrepTestWorktree(t)
	version, err := svc.InstallRipgrep(context.Background(), worktreeID)
	if err != nil {
		t.Fatalf("InstallRipgrep failed: %v", err)
	}
	if version != "15.2.0" {
		t.Errorf("version = %q, want 15.2.0", version)
	}
	if gotGOOS != "linux" || gotGOARCH != "arm64" {
		t.Errorf("installRipgrepLocal called with (%q, %q), want (linux, arm64)", gotGOOS, gotGOARCH)
	}
}

func TestWorktreeFileServiceInstallRipgrepReportsNotFoundForUnknownWorktree(t *testing.T) {
	svc, _ := newGrepTestWorktree(t)
	if _, err := svc.InstallRipgrep(context.Background(), "w-does-not-exist"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("InstallRipgrep for unknown worktree error = %v, want store.ErrNotFound", err)
	}
}

func TestWorktreeFileServiceInstallRipgrepPropagatesInstallError(t *testing.T) {
	origInstall := installRipgrepLocal
	installRipgrepLocal = func(ctx context.Context, goos, goarch string) (string, string, error) {
		return "", "", fmt.Errorf("rginstall: unsupported platform %s/%s", goos, goarch)
	}
	defer func() { installRipgrepLocal = origInstall }()

	svc, worktreeID := newGrepTestWorktree(t)
	if _, err := svc.InstallRipgrep(context.Background(), worktreeID); err == nil {
		t.Fatal("expected InstallRipgrep to propagate the install error, got nil")
	}
}
