package detect

import (
	"os"
	"path/filepath"
	"testing"
)

// stubShellPathDirs replaces shellPathDirs for the duration of a test so
// Resolve's login-shell fallback doesn't spawn a real shell and pick up
// whatever happens to be installed on the machine running the test.
func stubShellPathDirs(t *testing.T, dirs []string) {
	t.Helper()
	orig := shellPathDirs
	shellPathDirs = func() []string { return dirs }
	t.Cleanup(func() { shellPathDirs = orig })
}

func TestResolveFallsBackToWellKnownDirsWhenNotOnPATH(t *testing.T) {
	stubShellPathDirs(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty")) // strip PATH so LookPath can't find it

	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "claude")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := Resolve("claude")
	if err != nil {
		t.Fatalf("Resolve(\"claude\") returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("Resolve(\"claude\") = %q, want %q", got, binPath)
	}
}

func TestResolveErrorsWhenBinaryNowhereToBeFound(t *testing.T) {
	stubShellPathDirs(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))

	if _, err := Resolve("claude"); err == nil {
		t.Error("Resolve(\"claude\") expected error when binary is not installed anywhere, got nil")
	}
}

func TestResolveFallsBackToShellPathWhenNotInWellKnownDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))

	// Simulate a binary that only lands on PATH via shell rc files (custom
	// npm prefix, pipx, mise, asdf, ...) — not in any of the hardcoded
	// fallbackDirs locations.
	customDir := filepath.Join(home, "custom-prefix", "bin")
	if err := os.MkdirAll(customDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(customDir, "codex")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	stubShellPathDirs(t, []string{customDir})

	got, err := Resolve("codex")
	if err != nil {
		t.Fatalf("Resolve(\"codex\") returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("Resolve(\"codex\") = %q, want %q", got, binPath)
	}
}
