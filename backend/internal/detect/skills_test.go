package detect

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
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
	matches, err := filepath.Glob(filepath.Join(home, ".devdeck", "trash", "skills", "claude", "claude-only-*"))
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

func TestReadAndWriteSkillContent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude", "skills", "editable")
	path := filepath.Join(dir, "SKILL.md")
	original := "---\nname: editable\ndescription: Before\n---\n\nOld body.\n"
	writeTestSkill(t, dir, original)
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o640); err != nil {
			t.Fatal(err)
		}
	}

	content, readOnly, linked, err := ReadSkillContent("claude", "editable")
	if err != nil {
		t.Fatal(err)
	}
	if content != original || readOnly || linked {
		t.Fatalf("ReadSkillContent = (%q, %v, %v), want original, false, false", content, readOnly, linked)
	}

	updated := "---\nname: editable\ndescription: After\ncategory: testing\n---\n\nNew body.\n"
	if err := WriteSkillContent("claude", "editable", updated); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != updated {
		t.Fatalf("updated content = %q, want %q", raw, updated)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o640 {
			t.Fatalf("updated mode = %o, want 640", got)
		}
	}
}

func TestSkillContentReadOnlySystemSkill(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex", "skills", ".system", "system-skill")
	original := "---\nname: system-skill\n---\n\nSystem.\n"
	writeTestSkill(t, dir, original)

	content, readOnly, linked, err := ReadSkillContent("codex", "system-skill")
	if err != nil {
		t.Fatal(err)
	}
	if content != original || !readOnly || linked {
		t.Fatalf("ReadSkillContent = (%q, %v, %v), want original, true, false", content, readOnly, linked)
	}
	if err := WriteSkillContent("codex", "system-skill", original); !errors.Is(err, port.ErrIntegrationConflict) {
		t.Fatalf("WriteSkillContent error = %v, want integration conflict", err)
	}
}

func TestSkillContentLinkedTargets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink behavior is covered on Unix")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeRoot := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(claudeRoot, 0o700); err != nil {
		t.Fatal(err)
	}

	t.Run("managed source is editable", func(t *testing.T) {
		source := filepath.Join(home, ".agents", "skills", "shared")
		original := "---\nname: shared\n---\n\nBefore.\n"
		writeTestSkill(t, source, original)
		if err := os.Symlink(source, filepath.Join(claudeRoot, "shared")); err != nil {
			t.Fatal(err)
		}

		content, readOnly, linked, err := ReadSkillContent("claude", "shared")
		if err != nil {
			t.Fatal(err)
		}
		if content != original || readOnly || !linked {
			t.Fatalf("ReadSkillContent = (%q, %v, %v), want original, false, true", content, readOnly, linked)
		}
		updated := "---\nname: shared\n---\n\nAfter.\n"
		if err := WriteSkillContent("claude", "shared", updated); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(source, "SKILL.md"))
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != updated {
			t.Fatalf("source content = %q, want %q", raw, updated)
		}
	})

	t.Run("external source is view only", func(t *testing.T) {
		source := filepath.Join(home, "external", "external-skill")
		original := "---\nname: external-skill\n---\n\nExternal.\n"
		writeTestSkill(t, source, original)
		if err := os.Symlink(source, filepath.Join(claudeRoot, "external-skill")); err != nil {
			t.Fatal(err)
		}

		content, readOnly, linked, err := ReadSkillContent("claude", "external-skill")
		if err != nil {
			t.Fatal(err)
		}
		if content != original || !readOnly || !linked {
			t.Fatalf("ReadSkillContent = (%q, %v, %v), want original, true, true", content, readOnly, linked)
		}
		if err := WriteSkillContent("claude", "external-skill", original); !errors.Is(err, port.ErrIntegrationConflict) {
			t.Fatalf("WriteSkillContent error = %v, want integration conflict", err)
		}
	})
}

func TestWriteSkillContentValidation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude", "skills", "validated")
	path := filepath.Join(dir, "SKILL.md")
	original := "---\nname: validated\n---\n\nOriginal.\n"
	writeTestSkill(t, dir, original)

	cases := map[string]string{
		"oversized":            "---\nname: validated\n---\n" + strings.Repeat("x", maxSkillContentBytes),
		"invalid utf8":         "---\nname: validated\n---\n" + string([]byte{0xff}),
		"nul byte":             "---\nname: validated\n---\n\x00",
		"missing frontmatter":  "Plain markdown only.\n",
		"unclosed frontmatter": "---\nname: validated\n",
		"changed name":         "---\nname: renamed\n---\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			err := WriteSkillContent("claude", "validated", content)
			if !errors.Is(err, port.ErrIntegrationConflict) {
				t.Fatalf("WriteSkillContent error = %v, want integration conflict", err)
			}
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if string(raw) != original {
				t.Fatalf("original changed after rejected write: %q", raw)
			}
		})
	}
}

func TestSkillContentRejectsInvalidNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, name := range []string{"", ".hidden", "../skill", "nested/skill", "bad name"} {
		if _, _, _, err := ReadSkillContent("claude", name); !errors.Is(err, port.ErrIntegrationConflict) {
			t.Errorf("ReadSkillContent(%q) error = %v, want integration conflict", name, err)
		}
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
