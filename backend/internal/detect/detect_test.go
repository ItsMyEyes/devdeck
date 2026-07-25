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

// stubTailscaleExtraPaths replaces tailscaleExtraPaths for the duration of a
// test so ResolveTailscale's app-bundle fallback doesn't depend on running
// on macOS or on what's actually installed on the machine running the test.
func stubTailscaleExtraPaths(t *testing.T, paths []string) {
	t.Helper()
	orig := tailscaleExtraPaths
	tailscaleExtraPaths = func() []string { return paths }
	t.Cleanup(func() { tailscaleExtraPaths = orig })
}

func TestResolveTailscaleFallsBackToAppBundlePathWhenNotOnPATH(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))
	stubShellPathDirs(t, nil)

	appDir := filepath.Join(home, "Tailscale.app", "Contents", "MacOS")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(appDir, "Tailscale")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	stubTailscaleExtraPaths(t, []string{binPath})

	got, err := ResolveTailscale()
	if err != nil {
		t.Fatalf("ResolveTailscale() returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("ResolveTailscale() = %q, want %q", got, binPath)
	}
}

func TestResolveTailscalePrefersPATHOverAppBundlePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	stubShellPathDirs(t, nil)

	pathDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatal(err)
	}
	onPath := filepath.Join(pathDir, "tailscale")
	if err := os.WriteFile(onPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", pathDir)
	// Never consulted when PATH already resolves it — a nonexistent path
	// here would fail the test if ResolveTailscale looked at it anyway.
	stubTailscaleExtraPaths(t, []string{filepath.Join(home, "does-not-exist")})

	got, err := ResolveTailscale()
	if err != nil {
		t.Fatalf("ResolveTailscale() returned error: %v", err)
	}
	if got != onPath {
		t.Errorf("ResolveTailscale() = %q, want %q", got, onPath)
	}
}

func TestResolveTailscaleErrorsWhenNowhereToBeFound(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))
	stubShellPathDirs(t, nil)
	stubTailscaleExtraPaths(t, nil)

	if _, err := ResolveTailscale(); err == nil {
		t.Error("ResolveTailscale() expected error when binary is not installed anywhere, got nil")
	}
}

func TestResolveFallsBackToGoBinDirWhenNotInWellKnownDirs(t *testing.T) {
	stubShellPathDirs(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))
	t.Setenv("GOPATH", "")

	binDir := filepath.Join(home, "go", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "gopls")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveBinary("gopls")
	if err != nil {
		t.Fatalf("ResolveBinary(\"gopls\") returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("ResolveBinary(\"gopls\") = %q, want %q", got, binPath)
	}
}

func TestResolveFallsBackToGOPATHBinDirWhenSet(t *testing.T) {
	stubShellPathDirs(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))

	gopath := t.TempDir()
	t.Setenv("GOPATH", gopath)

	binDir := filepath.Join(gopath, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "gopls")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveBinary("gopls")
	if err != nil {
		t.Fatalf("ResolveBinary(\"gopls\") returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("ResolveBinary(\"gopls\") = %q, want %q", got, binPath)
	}
}

func TestResolveFallsBackToCargoBinDir(t *testing.T) {
	stubShellPathDirs(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty"))

	binDir := filepath.Join(home, ".cargo", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "rust-analyzer")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveBinary("rust-analyzer")
	if err != nil {
		t.Fatalf("ResolveBinary(\"rust-analyzer\") returned error: %v", err)
	}
	if got != binPath {
		t.Errorf("ResolveBinary(\"rust-analyzer\") = %q, want %q", got, binPath)
	}
}

func TestProjectLanguagesDetectsMarkerFiles(t *testing.T) {
	tests := []struct {
		name    string
		marker  string
		content string
		want    string
	}{
		{"go.mod", "go.mod", "module example.com/foo\n", "go"},
		{"package.json", "package.json", "{}", "typescript"},
		{"pyproject.toml", "pyproject.toml", "[project]\n", "python"},
		{"requirements.txt", "requirements.txt", "requests\n", "python"},
		{"setup.py", "setup.py", "", "python"},
		{"Cargo.toml", "Cargo.toml", "[package]\n", "rust"},
		{"pom.xml", "pom.xml", "<project></project>", "java"},
		{"build.gradle", "build.gradle", "", "java"},
		{"build.gradle.kts", "build.gradle.kts", "", "java"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, tt.marker), []byte(tt.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got := ProjectLanguages(root)
			if len(got) != 1 || got[0] != tt.want {
				t.Errorf("ProjectLanguages() with %s = %v, want [%s]", tt.marker, got, tt.want)
			}
		})
	}
}

func TestProjectLanguagesDetectsMultipleMarkers(t *testing.T) {
	root := t.TempDir()
	for _, marker := range []string{"go.mod", "package.json"} {
		if err := os.WriteFile(filepath.Join(root, marker), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := ProjectLanguages(root)
	want := map[string]bool{"go": true, "typescript": true}
	if len(got) != len(want) {
		t.Fatalf("ProjectLanguages() = %v, want 2 languages", got)
	}
	for _, lang := range got {
		if !want[lang] {
			t.Errorf("ProjectLanguages() unexpected language %q", lang)
		}
	}
}

func TestProjectLanguagesReturnsNilWhenNoMarkersFound(t *testing.T) {
	root := t.TempDir()
	if got := ProjectLanguages(root); len(got) != 0 {
		t.Errorf("ProjectLanguages() = %v, want empty", got)
	}
}

func TestProjectLanguagesIgnoresNonexistentRoot(t *testing.T) {
	if got := ProjectLanguages(filepath.Join(t.TempDir(), "does-not-exist")); len(got) != 0 {
		t.Errorf("ProjectLanguages() = %v, want empty for a missing directory", got)
	}
}
