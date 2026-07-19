package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceSelf_Unix(t *testing.T) {
	dir := t.TempDir()
	execPath := filepath.Join(dir, "devdeck-api")
	if err := os.WriteFile(execPath, []byte("old-contents"), 0o755); err != nil {
		t.Fatalf("seed exec file: %v", err)
	}

	if err := ReplaceSelf("linux", execPath, []byte("new-contents")); err != nil {
		t.Fatalf("ReplaceSelf() error = %v", err)
	}

	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(got) != "new-contents" {
		t.Errorf("content = %q, want %q", got, "new-contents")
	}

	info, err := os.Stat(execPath)
	if err != nil {
		t.Fatalf("stat replaced file: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("mode = %v, want an executable bit set", info.Mode())
	}

	assertNoLeftoverTempFiles(t, dir)
}

func TestReplaceSelf_Windows(t *testing.T) {
	dir := t.TempDir()
	execPath := filepath.Join(dir, "devdeck-api.exe")
	if err := os.WriteFile(execPath, []byte("old-contents"), 0o755); err != nil {
		t.Fatalf("seed exec file: %v", err)
	}

	if err := ReplaceSelf("windows", execPath, []byte("new-contents")); err != nil {
		t.Fatalf("ReplaceSelf() error = %v", err)
	}

	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(got) != "new-contents" {
		t.Errorf("content = %q, want %q", got, "new-contents")
	}

	if _, err := os.Stat(execPath + ".old"); !os.IsNotExist(err) {
		t.Errorf(".old leftover file present or stat error: %v", err)
	}

	assertNoLeftoverTempFiles(t, dir)
}

func assertNoLeftoverTempFiles(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".devdeck-update-*"))
	if err != nil {
		t.Fatalf("glob temp files: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("leftover temp files: %v", matches)
	}
}
