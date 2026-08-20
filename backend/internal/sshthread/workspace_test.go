package sshthread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/sshtoolcli"
)

func TestSeedWritesWorkspace(t *testing.T) {
	root := t.TempDir()
	dir, err := Seed(root, Binding{
		HubURL: "http://127.0.0.1:8989", ThreadID: "ssh:c-1", ConnectionID: "c-1",
		Label: "Superapps Dev1", Host: "172.27.168.190", User: "clouduser", Token: "secret-token",
	}, "/opt/devdeck/devdeck")
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md", ".claude/skills/devops-ssh/SKILL.md", ".devdeck/session.json"} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			t.Errorf("missing %s: %v", rel, err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, ".devdeck/session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("session.json mode = %v, want 0600", info.Mode().Perm())
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".devdeck/session.json"))
	var b Binding
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatalf("session.json is not valid JSON: %v", err)
	}
	if b.Token != "secret-token" || b.ConnectionID != "c-1" {
		t.Fatalf("binding round-trip failed: %+v", b)
	}
	agents, _ := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if strings.Contains(string(agents), "secret-token") {
		t.Fatal("token leaked into AGENTS.md")
	}
}

func TestSeedIsIdempotentAndRefreshes(t *testing.T) {
	root := t.TempDir()
	dir, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "one"}, "/opt/one/devdeck")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "two"}, "/opt/two/devdeck"); err != nil {
		t.Fatalf("second Seed: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".devdeck/session.json"))
	if !strings.Contains(string(raw), "two") {
		t.Fatal("re-seed did not refresh the token")
	}
	// An upgraded or relocated install has to correct the shim too, or the
	// thread keeps calling the executable of a previous session.
	shim, _ := os.ReadFile(filepath.Join(BinDir(dir), sshtoolcli.HelperName))
	if !strings.Contains(string(shim), "/opt/two/devdeck") {
		t.Fatalf("re-seed did not refresh the shim's target: %q", shim)
	}
}

// The shim is the whole reason DevDeck ships one binary instead of two, so it
// has to be present, executable, and pointed at the host executable — anything
// less and every tool call the agent makes is "command not found".
func TestSeedWritesExecutableShimForHostExecutable(t *testing.T) {
	dir, err := Seed(t.TempDir(), Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "t"}, "/opt/dev deck/devdeck")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(BinDir(dir), sshtoolcli.HelperName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("shim missing: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("shim mode = %v, want the owner execute bit set", info.Mode().Perm())
	}
	shim, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// A path with a space must survive as one argument, and the subcommand has
	// to be the one Dispatch actually recognises.
	if want := "exec '/opt/dev deck/devdeck' " + sshtoolcli.Subcommand + ` "$@"`; !strings.Contains(string(shim), want) {
		t.Errorf("shim = %q, want it to contain %q", shim, want)
	}
}

// hostExecutable returns "" when it cannot resolve a usable path, and Seed must
// still produce a working workspace in that case: the agent then reports an
// honest "command not found" instead of a shell error from a dangling shim.
func TestSeedWithoutHostExecutableWritesNoShim(t *testing.T) {
	dir, err := Seed(t.TempDir(), Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "t"}, "")
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "AGENTS.md")); err != nil {
		t.Errorf("workspace was not seeded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(BinDir(dir), sshtoolcli.HelperName)); !os.IsNotExist(err) {
		t.Errorf("shim exists with no host executable (err = %v)", err)
	}
}

func TestSlugForThreadIsFilesystemSafe(t *testing.T) {
	if got := SlugForThread("ssh:c-1::chat-2"); strings.ContainsAny(got, ":/\\") {
		t.Fatalf("slug %q is not filesystem-safe", got)
	}
}
