package detect

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"loom/backend/internal/port"
)

func TestReadInstallAndRemoveSkills(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink behavior is covered on Unix; Windows uses the copy fallback")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)

	writeTestSkill(t, filepath.Join(home, ".agents", "skills", "shared-skill"), `---
name: shared-skill
description: Shared across agents
od:
  category: testing
---
`)
	writeTestSkill(t, filepath.Join(home, ".claude", "skills", "claude-only"), `---
name: claude-only
description: |
  First line.
  Second line.
---
`)

	codexSkills := ReadSkills("codex")
	if len(codexSkills) != 1 || codexSkills[0].Name != "shared-skill" {
		t.Fatalf("ReadSkills(codex) = %#v", codexSkills)
	}
	if codexSkills[0].Category != "testing" {
		t.Fatalf("category = %q, want testing", codexSkills[0].Category)
	}

	if err := InstallSkill("claude", "shared-skill"); err != nil {
		t.Fatalf("InstallSkill: %v", err)
	}
	link := filepath.Join(home, ".claude", "skills", "shared-skill")
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("installed skill is not a symlink: info=%v err=%v", info, err)
	}

	claudeSkills := ReadSkills("claude")
	if len(claudeSkills) != 2 {
		t.Fatalf("ReadSkills(claude) count = %d, want 2: %#v", len(claudeSkills), claudeSkills)
	}

	if err := RemoveSkill("claude", "shared-skill"); err != nil {
		t.Fatalf("RemoveSkill linked: %v", err)
	}
	if _, err := os.Lstat(link); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("linked skill still exists: %v", err)
	}

	if err := RemoveSkill("claude", "claude-only"); err != nil {
		t.Fatalf("RemoveSkill directory: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(home, ".loom", "trash", "skills", "claude", "claude-only-*"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("trash matches = %v, err=%v", matches, err)
	}
}

func TestRemoveSkillRejectsLinkedSource(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink behavior is covered on Unix")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	source := filepath.Join(home, ".agents", "skills", "shared")
	writeTestSkill(t, source, "---\nname: shared\n---\n")
	claudeRoot := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(claudeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(source, filepath.Join(claudeRoot, "shared")); err != nil {
		t.Fatal(err)
	}

	err := RemoveSkill("codex", "shared")
	if !errors.Is(err, port.ErrIntegrationConflict) {
		t.Fatalf("RemoveSkill error = %v, want integration conflict", err)
	}
}

func writeTestSkill(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
