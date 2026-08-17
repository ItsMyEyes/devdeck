package sshthread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeedWritesWorkspace(t *testing.T) {
	root := t.TempDir()
	dir, err := Seed(root, Binding{
		HubURL: "http://127.0.0.1:8989", ThreadID: "ssh:c-1", ConnectionID: "c-1",
		Label: "Superapps Dev1", Host: "172.27.168.190", User: "clouduser", Token: "secret-token",
	})
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
	dir, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "two"}); err != nil {
		t.Fatalf("second Seed: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".devdeck/session.json"))
	if !strings.Contains(string(raw), "two") {
		t.Fatal("re-seed did not refresh the token")
	}
}

func TestSlugForThreadIsFilesystemSafe(t *testing.T) {
	if got := SlugForThread("ssh:c-1::chat-2"); strings.ContainsAny(got, ":/\\") {
		t.Fatalf("slug %q is not filesystem-safe", got)
	}
}
