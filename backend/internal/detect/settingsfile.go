package detect

import (
	"os"
	"path/filepath"
	"strings"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// This file locates the configuration file each supported agent CLI reads, so
// Agent management → Settings → "Settings file" can open it directly.
//
// Deliberately separate from agentSettingsPath in envprofile.go, which looks
// nearly identical but answers a different question. That one backs LLM *env
// profiles* — a feature only claude and codex implement — and widening it would
// make ApplyEnvProfile write a claude-shaped `env` block into a file the other
// agents never read. The raw editor has no such constraint: it hands the
// operator their own file back, so it covers every agent DevDeck detects.

// settingsFileSpec describes where one agent keeps its config and how to read
// it. candidates are absolute paths, most-preferred first: a read takes the
// first that exists, and a write with none present creates candidates[0].
type settingsFileSpec struct {
	candidates []string
	// syntax is the editor language: "json", "jsonc" or "toml".
	syntax string
	// empty is what a not-yet-created file reads as, so the editor opens on
	// something valid for the format rather than an error.
	empty string
}

func settingsFileSpecFor(agentID string) (settingsFileSpec, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return settingsFileSpec{}, err
	}
	switch agentID {
	case "claude":
		return settingsFileSpec{
			candidates: []string{filepath.Join(home, ".claude", "settings.json")},
			syntax:     "json",
			empty:      "{}",
		}, nil
	case "codex":
		return settingsFileSpec{
			candidates: []string{filepath.Join(home, ".codex", "config.toml")},
			syntax:     "toml",
			empty:      "",
		}, nil
	case "pi":
		// PI_CODING_AGENT_DIR — the same ~/.pi/agent directory readPiModels
		// already reads models.json and settings.json out of.
		return settingsFileSpec{
			candidates: []string{filepath.Join(home, ".pi", "agent", "settings.json")},
			syntax:     "json",
			empty:      "{}",
		}, nil
	case "opencode":
		// opencode accepts either extension for its global config and this
		// machine may well have both (`opencode mcp add` writes .jsonc, the
		// docs name .json). Whichever exists is the one it is actually
		// running, so edit that rather than creating a second file that
		// shadows it. Syntax is jsonc: comments are legal in both.
		dir := filepath.Join(home, ".config", "opencode")
		return settingsFileSpec{
			candidates: []string{
				filepath.Join(dir, "opencode.json"),
				filepath.Join(dir, "opencode.jsonc"),
			},
			syntax: "jsonc",
			empty:  "{}",
		}, nil
	case "gemini":
		return settingsFileSpec{
			candidates: []string{filepath.Join(home, ".gemini", "settings.json")},
			syntax:     "json",
			empty:      "{}",
		}, nil
	default:
		return settingsFileSpec{}, port.ErrAgentManagementUnsupported
	}
}

// resolve returns the candidate to act on and whether it exists on disk.
func (s settingsFileSpec) resolve() (string, bool) {
	for _, path := range s.candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, true
		}
	}
	return s.candidates[0], false
}

// ReadSettingsFile returns an agent's config file with the path and syntax the
// editor needs to label and highlight it. A file the agent has not created yet
// is not an error — it reads as the empty default for its format.
func ReadSettingsFile(agentID string) (domain.AgentSettingsFile, error) {
	spec, err := settingsFileSpecFor(agentID)
	if err != nil {
		return domain.AgentSettingsFile{}, err
	}
	path, exists := spec.resolve()
	file := domain.AgentSettingsFile{
		Path:    displaySettingsPath(path),
		Syntax:  spec.syntax,
		Content: spec.empty,
	}
	if !exists {
		return file, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return file, nil
		}
		return domain.AgentSettingsFile{}, err
	}
	file.Content = string(data)
	return file, nil
}

// WriteSettingsFile atomically writes raw text to an agent's config file. No
// validation is performed — the caller takes responsibility for the syntax,
// which is why the editor refuses to save malformed JSON before calling here.
func WriteSettingsFile(agentID, content string) error {
	spec, err := settingsFileSpecFor(agentID)
	if err != nil {
		return err
	}
	path, _ := spec.resolve()
	return atomicWrite(path, []byte(content), 0o600)
}

// displaySettingsPath shortens a path under $HOME to ~/… — the only form the
// client is given, since an absolute path just leaks the operator's home
// directory into the UI without telling them anything they don't know.
func displaySettingsPath(path string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	rel, err := filepath.Rel(home, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return path
	}
	return "~/" + filepath.ToSlash(rel)
}
