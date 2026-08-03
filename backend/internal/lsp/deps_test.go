package lsp

import (
	"runtime"
	"strings"
	"testing"
)

// stubVersion replaces probeVersion for the duration of a test so the suite
// never depends on which toolchains are installed on the machine running it —
// the same overridable-package-var pattern runInstallCommand uses.
func stubVersion(t *testing.T, fn func(path string, args []string) string) {
	t.Helper()
	orig := probeVersion
	probeVersion = fn
	t.Cleanup(func() { probeVersion = orig })
}

func TestReportCoversEveryServerExactlyOnce(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	report := Report()
	if len(report.Languages) != len(dependencyGroups) {
		t.Fatalf("got %d language groups, want %d", len(report.Languages), len(dependencyGroups))
	}

	// languageServers maps eight language ids onto five binaries; the report
	// must collapse them rather than listing tsserver four times.
	seen := make(map[string]int)
	for _, lang := range report.Languages {
		seen[lang.Server.Name]++
	}
	for name, count := range seen {
		if count != 1 {
			t.Errorf("%s appears %d times, want 1", name, count)
		}
	}
}

func TestReportIsOrderedNotMapRandomised(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	first := Report()
	for i := 0; i < 5; i++ {
		next := Report()
		for j := range first.Languages {
			if first.Languages[j].Label != next.Languages[j].Label {
				t.Fatalf("order changed between calls at %d: %q vs %q",
					j, first.Languages[j].Label, next.Languages[j].Label)
			}
		}
	}
}

func TestReportPairsEachServerWithItsPrerequisite(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	report := Report()
	want := map[string]string{
		"gopls":                      "go",
		"typescript-language-server": "npm",
		"pyright-langserver":         "npm",
		"rust-analyzer":              "rustup",
		"jdtls":                      "brew",
	}
	for _, lang := range report.Languages {
		if got := lang.Prerequisite.Name; got != want[lang.Server.Name] {
			t.Errorf("%s prerequisite = %q, want %q", lang.Server.Name, got, want[lang.Server.Name])
		}
	}
}

func TestReportIncludesSpawnPath(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	report := Report()
	if report.SpawnPath == "" {
		t.Fatal("SpawnPath is empty; the UI needs it to explain a server that cannot reach its toolchain")
	}
	if report.OS != runtime.GOOS {
		t.Errorf("OS = %q, want %q", report.OS, runtime.GOOS)
	}
}

func TestReportVersionComesFromTheResolvedPath(t *testing.T) {
	var probed []string
	stubVersion(t, func(path string, args []string) string {
		probed = append(probed, path+" "+strings.Join(args, " "))
		return "v1.2.3"
	})

	report := Report()
	for _, lang := range report.Languages {
		if lang.Server.Installed && lang.Server.Version != "v1.2.3" {
			t.Errorf("%s installed but version = %q", lang.Server.Name, lang.Server.Version)
		}
		if !lang.Server.Installed && lang.Server.Version != "" {
			t.Errorf("%s not installed but reported version %q", lang.Server.Name, lang.Server.Version)
		}
	}
	if len(probed) == 0 {
		t.Skip("no toolchain installed on this machine; nothing to probe")
	}
}

func TestJdtlsIsNotInstallableOffDarwin(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	report := Report()
	for _, lang := range report.Languages {
		if lang.Server.Name != "jdtls" {
			continue
		}
		if runtime.GOOS != "darwin" {
			if lang.Installable {
				t.Error("jdtls reported installable off darwin")
			}
			if !strings.Contains(lang.Blocker, runtime.GOOS) {
				t.Errorf("blocker %q does not name the platform", lang.Blocker)
			}
		}
		return
	}
	t.Fatal("jdtls missing from the report")
}

func TestBlockerNamesTheMissingPrerequisite(t *testing.T) {
	stubVersion(t, func(string, []string) string { return "" })

	report := Report()
	for _, lang := range report.Languages {
		if lang.Installable {
			if lang.Blocker != "" {
				t.Errorf("%s is installable but has blocker %q", lang.Server.Name, lang.Blocker)
			}
			if !lang.Prerequisite.Installed {
				t.Errorf("%s installable with a missing prerequisite", lang.Server.Name)
			}
			continue
		}
		if lang.Blocker == "" {
			t.Errorf("%s is not installable but gives no reason", lang.Server.Name)
		}
	}
}

func TestKnownBinaryRejectsArbitraryStrings(t *testing.T) {
	if !KnownBinary("gopls") {
		t.Error("gopls should be known")
	}
	if KnownBinary("rm") {
		t.Error("KnownBinary must reject anything not in dependencyGroups — it guards an exec call")
	}
	if KnownBinary("") {
		t.Error("empty string should not be known")
	}
}
