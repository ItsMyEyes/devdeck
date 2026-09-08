package detect

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"devdeck/backend/internal/port"
)

// homeDir points os.UserHomeDir() at a scratch directory for one test.
func homeDir(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

// The raw settings-file editor is offered for every agent DevDeck detects, so
// adding one to AgentBinary without teaching this file where its config lives
// would ship a Settings tab that errors for that agent only.
func TestSettingsFileSpecCoversEveryDetectedAgent(t *testing.T) {
	homeDir(t)
	ids := make([]string, 0, len(AgentBinary))
	for id := range AgentBinary {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		spec, err := settingsFileSpecFor(id)
		if err != nil {
			t.Errorf("settingsFileSpecFor(%q): %v", id, err)
			continue
		}
		if len(spec.candidates) == 0 {
			t.Errorf("settingsFileSpecFor(%q): no candidate paths", id)
		}
		switch spec.syntax {
		case "json", "jsonc", "toml":
		default:
			t.Errorf("settingsFileSpecFor(%q): syntax %q is not an editor language", id, spec.syntax)
		}
	}
}

func TestSettingsFileSpecRejectsUnknownAgent(t *testing.T) {
	homeDir(t)
	if _, err := settingsFileSpecFor("cursor"); !errors.Is(err, port.ErrAgentManagementUnsupported) {
		t.Fatalf("settingsFileSpecFor(unknown) = %v, want ErrAgentManagementUnsupported", err)
	}
}

// A machine where the agent has never written a config is the common case for
// a freshly installed CLI. The editor has to open on something valid for the
// format instead of an error, and still name the file it would create.
func TestReadSettingsFileDefaultsWhenMissing(t *testing.T) {
	homeDir(t)
	for _, tc := range []struct {
		agentID, path, syntax, content string
	}{
		{"claude", "~/.claude/settings.json", "json", "{}"},
		{"codex", "~/.codex/config.toml", "toml", ""},
		{"pi", "~/.pi/agent/settings.json", "json", "{}"},
		{"opencode", "~/.config/opencode/opencode.json", "jsonc", "{}"},
		{"gemini", "~/.gemini/settings.json", "json", "{}"},
	} {
		file, err := ReadSettingsFile(tc.agentID)
		if err != nil {
			t.Fatalf("ReadSettingsFile(%q): %v", tc.agentID, err)
		}
		if file.Path != tc.path {
			t.Errorf("%s path = %q, want %q", tc.agentID, file.Path, tc.path)
		}
		if file.Syntax != tc.syntax {
			t.Errorf("%s syntax = %q, want %q", tc.agentID, file.Syntax, tc.syntax)
		}
		if file.Content != tc.content {
			t.Errorf("%s content = %q, want %q", tc.agentID, file.Content, tc.content)
		}
	}
}

func TestReadSettingsFileReturnsExistingContent(t *testing.T) {
	home := homeDir(t)
	path := filepath.Join(home, ".pi", "agent", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"model":"gpt-5"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	file, err := ReadSettingsFile("pi")
	if err != nil {
		t.Fatalf("ReadSettingsFile: %v", err)
	}
	if file.Content != `{"model":"gpt-5"}` {
		t.Errorf("content = %q, want the file on disk", file.Content)
	}
	if file.Path != "~/.pi/agent/settings.json" {
		t.Errorf("path = %q, want the ~-shortened path", file.Path)
	}
}

// opencode reads either extension, and `opencode mcp add` writes .jsonc while
// its docs name .json. Editing the one that is NOT there would create a second
// file that silently shadows (or is shadowed by) the live one.
func TestReadSettingsFilePrefersTheOpencodeFileThatExists(t *testing.T) {
	home := homeDir(t)
	dir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "opencode.jsonc"), []byte("// live\n{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	file, err := ReadSettingsFile("opencode")
	if err != nil {
		t.Fatalf("ReadSettingsFile: %v", err)
	}
	if file.Path != "~/.config/opencode/opencode.jsonc" {
		t.Errorf("path = %q, want the .jsonc file that exists", file.Path)
	}
	if file.Content != "// live\n{}" {
		t.Errorf("content = %q, want the .jsonc file's text", file.Content)
	}

	// And a save goes back to that same file rather than creating opencode.json.
	if err := WriteSettingsFile("opencode", "// edited\n{}"); err != nil {
		t.Fatalf("WriteSettingsFile: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "opencode.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "// edited\n{}" {
		t.Errorf("opencode.jsonc = %q, want the edit", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "opencode.json")); !os.IsNotExist(err) {
		t.Error("writing created a second opencode.json that shadows the live config")
	}
}

// A first save for an agent that has never been configured has to create the
// directory too — ~/.gemini does not exist until gemini itself writes there.
func TestWriteSettingsFileCreatesMissingDirectory(t *testing.T) {
	home := homeDir(t)

	if err := WriteSettingsFile("gemini", `{"theme":"dark"}`); err != nil {
		t.Fatalf("WriteSettingsFile: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(home, ".gemini", "settings.json"))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if string(got) != `{"theme":"dark"}` {
		t.Errorf("settings.json = %q, want the saved content", got)
	}

	file, err := ReadSettingsFile("gemini")
	if err != nil {
		t.Fatalf("ReadSettingsFile: %v", err)
	}
	if file.Content != `{"theme":"dark"}` {
		t.Errorf("round-tripped content = %q", file.Content)
	}
}

func TestWriteSettingsFileRejectsUnknownAgent(t *testing.T) {
	homeDir(t)
	if err := WriteSettingsFile("cursor", "{}"); !errors.Is(err, port.ErrAgentManagementUnsupported) {
		t.Fatalf("WriteSettingsFile(unknown) = %v, want ErrAgentManagementUnsupported", err)
	}
}
