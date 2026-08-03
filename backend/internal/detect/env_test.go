package detect

import (
	"os"
	"strings"
	"testing"
)

func sep() string { return string(os.PathListSeparator) }

func TestAugmentPathAppendsMissingDirs(t *testing.T) {
	got := augmentPath("/usr/bin"+sep()+"/bin", []string{"/opt/homebrew/bin", "/Users/x/go/bin"})
	want := strings.Join([]string{"/usr/bin", "/bin", "/opt/homebrew/bin", "/Users/x/go/bin"}, sep())
	if got != want {
		t.Fatalf("augmentPath = %q, want %q", got, want)
	}
}

func TestAugmentPathKeepsExistingPrecedence(t *testing.T) {
	// A dir already on PATH must keep its original position: appending it again
	// would be harmless, but reordering could shadow a toolchain the user
	// deliberately put first.
	got := augmentPath("/opt/homebrew/bin"+sep()+"/usr/bin", []string{"/usr/bin", "/opt/homebrew/bin"})
	want := "/opt/homebrew/bin" + sep() + "/usr/bin"
	if got != want {
		t.Fatalf("augmentPath = %q, want %q", got, want)
	}
}

func TestAugmentPathDropsEmptyEntries(t *testing.T) {
	got := augmentPath("/usr/bin"+sep()+sep()+"/bin", []string{"", "/opt/bin"})
	want := strings.Join([]string{"/usr/bin", "/bin", "/opt/bin"}, sep())
	if got != want {
		t.Fatalf("augmentPath = %q, want %q", got, want)
	}
}

func TestAugmentPathFromEmptyCurrent(t *testing.T) {
	got := augmentPath("", []string{"/opt/bin"})
	if got != "/opt/bin" {
		t.Fatalf("augmentPath = %q, want %q", got, "/opt/bin")
	}
}

func TestAugmentEnvRewritesOnlyPath(t *testing.T) {
	env := []string{"HOME=/Users/x", "PATH=/usr/bin", "GOPATH=/Users/x/go"}
	out := augmentEnv(env, []string{"/opt/homebrew/bin"})

	if len(out) != len(env) {
		t.Fatalf("augmentEnv changed entry count: got %d, want %d", len(out), len(env))
	}
	var path string
	for _, entry := range out {
		name, value, _ := strings.Cut(entry, "=")
		switch name {
		case "PATH":
			path = value
		case "HOME":
			if value != "/Users/x" {
				t.Errorf("HOME was modified: %q", value)
			}
		case "GOPATH":
			if value != "/Users/x/go" {
				t.Errorf("GOPATH was modified: %q", value)
			}
		}
	}
	if !strings.Contains(path, "/opt/homebrew/bin") {
		t.Fatalf("PATH missing the appended dir: %q", path)
	}
	if !strings.HasPrefix(path, "/usr/bin") {
		t.Fatalf("PATH lost its original precedence: %q", path)
	}
}

func TestAugmentEnvAddsPathWhenAbsent(t *testing.T) {
	// A child started from an environment with no PATH still needs a search
	// path, or it has none at all.
	out := augmentEnv([]string{"HOME=/Users/x"}, []string{"/opt/bin"})
	found := false
	for _, entry := range out {
		if entry == "PATH=/opt/bin" {
			found = true
		}
	}
	if !found {
		t.Fatalf("augmentEnv did not add a PATH entry: %v", out)
	}
}

func TestAugmentedEnvIncludesGoBinDir(t *testing.T) {
	// The end-to-end shape: whatever ResolveBinary can find, a child process
	// must also be able to find. goBinDir is the one that matters for gopls,
	// which shells out to `go`.
	stubShellPathDirs(t, nil)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	var path string
	for _, entry := range AugmentedEnv() {
		if name, value, _ := strings.Cut(entry, "="); pathKey(name) {
			path = value
		}
	}
	if !strings.Contains(path, goBinDir(home)) {
		t.Fatalf("AugmentedEnv PATH %q is missing goBinDir %q", path, goBinDir(home))
	}
}
