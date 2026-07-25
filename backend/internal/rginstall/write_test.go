package rginstall

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteExecutableCreatesParentDirsAndSetsExecBit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "bin", "rg")

	if err := writeExecutable(path, []byte("contents")); err != nil {
		t.Fatalf("writeExecutable failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(data) != "contents" {
		t.Errorf("contents = %q, want %q", data, "contents")
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("written file is not executable: mode=%v", info.Mode())
		}
	}
}

func TestWriteExecutableOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rg")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := writeExecutable(path, []byte("new")); err != nil {
		t.Fatalf("writeExecutable failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Errorf("contents = %q, want %q", data, "new")
	}
}

// TestWriteExecutableLeavesNoTempFileBehindOnSuccess proves the atomic
// temp-file-then-rename dance doesn't leak its scratch file once the final
// rename succeeds — mirroring selfupdate.ReplaceSelf's contract.
func TestWriteExecutableLeavesNoTempFileBehindOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rg")
	if err := writeExecutable(path, []byte("contents")); err != nil {
		t.Fatalf("writeExecutable failed: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "rg" {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("dir entries = %v, want exactly [rg]", names)
	}
}
