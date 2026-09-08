package detect

import (
	"errors"
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

// fakeTailscaleBin writes a stub `tailscale` executable whose behaviour is
// driven by script and returns its absolute path, so the JSON-parsing paths
// below can be exercised without a real tailnet.
func fakeTailscaleBin(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tailscale")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	return path
}

func TestTailscaleSelfURLWith(t *testing.T) {
	tests := []struct {
		name       string
		script     string // shell body of the fake CLI
		resolvable bool   // false: the CLI can't be located at all
		wantURL    string
		wantReason string
	}{
		{
			name:       "cli not installed",
			wantReason: "not_installed",
		},
		{
			name:       "cli exits non-zero",
			script:     "exit 1\n",
			resolvable: true,
			wantReason: "not_ready",
		},
		{
			name:       "cli prints unparseable json",
			script:     "echo not-json\n",
			resolvable: true,
			wantReason: "not_ready",
		},
		{
			name:       "logged out: empty dns name",
			script:     `echo '{"Self":{"DNSName":""}}'` + "\n",
			resolvable: true,
			wantReason: "not_ready",
		},
		{
			name:       "trailing dot trimmed",
			script:     `echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}'` + "\n",
			resolvable: true,
			wantURL:    "https://my-mac.tail1234.ts.net",
		},
		{
			name:       "dns name without trailing dot",
			script:     `echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net"}}'` + "\n",
			resolvable: true,
			wantURL:    "https://my-mac.tail1234.ts.net",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolve := func() (string, error) { return "", errors.New("not found") }
			if tt.resolvable {
				bin := fakeTailscaleBin(t, tt.script)
				resolve = func() (string, error) { return bin, nil }
			}
			gotURL, gotReason := TailscaleSelfURLWith(resolve)
			if gotURL != tt.wantURL || gotReason != tt.wantReason {
				t.Errorf("TailscaleSelfURLWith() = (%q, %q), want (%q, %q)", gotURL, gotReason, tt.wantURL, tt.wantReason)
			}
		})
	}
}

func TestTailscaleSelfURLResolvesTheCLIItself(t *testing.T) {
	bin := fakeTailscaleBin(t, `echo '{"Self":{"DNSName":"builder.tail-abc.ts.net."}}'`+"\n")
	t.Setenv("PATH", filepath.Dir(bin))

	gotURL, gotReason := TailscaleSelfURL()
	if gotURL != "https://builder.tail-abc.ts.net" || gotReason != "" {
		t.Errorf("TailscaleSelfURL() = (%q, %q), want (%q, %q)", gotURL, gotReason, "https://builder.tail-abc.ts.net", "")
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

// `tailscale serve status --json` nests a FOREGROUND mapping under
// "Foreground" keyed by a session id, not at the top level. devdeck runs serve
// in the foreground, so parsing only the top-level "Web" meant this function
// could never see devdeck's own mapping — it answered "unknown" every time,
// silently disabling the stale-target check built on top of it. Captured from
// a real `tailscale serve status --json` on tailscale 1.98.5.
func TestTailscaleServeTargetPortReadsForegroundSessions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tailscale")
	body := `{"Foreground":{"93511787b61d120d":{"TCP":{"443":{"HTTPS":true}},` +
		`"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18997"}}}}}}}`
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncat <<'JSON'\n"+body+"\nJSON\n"), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	got, ok := TailscaleServeTargetPort(func() (string, error) { return path, nil })
	if !ok || got != "18997" {
		t.Fatalf("TailscaleServeTargetPort() = %q/%v, want 18997/true", got, ok)
	}
}

// A background mapping still lives at the top level; both shapes must work.
func TestTailscaleServeTargetPortReadsBackgroundConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tailscale")
	body := `{"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8989"}}}}}`
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncat <<'JSON'\n"+body+"\nJSON\n"), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	got, ok := TailscaleServeTargetPort(func() (string, error) { return path, nil })
	if !ok || got != "8989" {
		t.Fatalf("TailscaleServeTargetPort() = %q/%v, want 8989/true", got, ok)
	}
}

// "No serve config" must read as unknown, never as a mismatch.
func TestTailscaleServeTargetPortReportsUnknownWhenUnconfigured(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tailscale")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho '{}'\n"), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	if got, ok := TailscaleServeTargetPort(func() (string, error) { return path, nil }); ok {
		t.Fatalf("TailscaleServeTargetPort() = %q/%v, want unknown", got, ok)
	}
}
