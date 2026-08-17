// Package sshthread seeds the local workspace DevDeck hands to a coding agent
// when a chat thread is attached to an SSH connection.
//
// The workspace holds instructions and one binding file, nothing else: the
// agent reaches the remote host through the devdeck-ssh helper, never through
// this directory. Seeding is idempotent and runs on every session start, so
// the instruction text always matches the binary that wrote it.
package sshthread

import (
	"embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

//go:embed assets/*.md
var assets embed.FS

// targetPlaceholder is the single substitution the workspace guide carries: the
// host this thread is bound to. Everything else in the guide is fixed text.
const targetPlaceholder = "{{TARGET}}"

const (
	dirMode  os.FileMode = 0o700
	fileMode os.FileMode = 0o600
)

// skillDir is where the agent looks for locally installed skills, in the layout
// detect.ReadSkills parses.
var skillDir = filepath.Join(".claude", "skills", "devops-ssh")

// ErrEmptyThreadID is returned by Seed when the binding carries no usable
// thread id, since the thread id is what names the workspace directory.
var ErrEmptyThreadID = errors.New("sshthread: binding has no usable thread id")

// Binding is DevDeck's machine-readable description of the SSH connection one
// chat thread is attached to. It is written to .devdeck/session.json (mode
// 0600) for the devdeck-ssh helper to load, and never rendered into any file
// the agent is invited to quote back.
type Binding struct {
	// HubURL is the base URL of the DevDeck API the helper calls.
	HubURL string `json:"hubUrl"`
	// ThreadID is the chat thread this workspace belongs to.
	ThreadID string `json:"threadId"`
	// ConnectionID is the SSH connection every helper call is pinned to.
	ConnectionID string `json:"connectionId"`
	// Label is the connection's human-facing name.
	Label string `json:"label"`
	// Host is the remote hostname or address, for display only.
	Host string `json:"host"`
	// User is the remote login user, for display only.
	User string `json:"user"`
	// Token authorises the helper against this thread's tool routes. Secret.
	Token string `json:"token"`
}

// Seed creates (or refreshes) the workspace for one thread under root and
// returns its absolute-relative path — root joined with the thread's slug.
//
// It writes AGENTS.md and a byte-identical CLAUDE.md, the devops-ssh skill, and
// the binding at .devdeck/session.json. Existing files are overwritten and
// their modes reasserted, so it is safe to call on every session start.
func Seed(root string, b Binding) (string, error) {
	slug := SlugForThread(b.ThreadID)
	if slug == "" {
		return "", ErrEmptyThreadID
	}
	dir := filepath.Join(root, slug)

	for _, sub := range []string{".", ".devdeck", skillDir} {
		if err := os.MkdirAll(filepath.Join(dir, sub), dirMode); err != nil {
			return "", err
		}
	}

	guide, err := renderGuide(b)
	if err != nil {
		return "", err
	}
	// AGENTS.md and CLAUDE.md are the same bytes under two names because
	// different agents look for different filenames.
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		if err := writeFile(filepath.Join(dir, name), guide); err != nil {
			return "", err
		}
	}

	skill, err := assets.ReadFile("assets/SKILL.md")
	if err != nil {
		return "", err
	}
	if err := writeFile(filepath.Join(dir, skillDir, "SKILL.md"), skill); err != nil {
		return "", err
	}

	session, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return "", err
	}
	if err := writeFile(filepath.Join(dir, ".devdeck", "session.json"), append(session, '\n')); err != nil {
		return "", err
	}
	return dir, nil
}

// SlugForThread turns a thread id into one filesystem-safe path segment.
// Characters outside [A-Za-z0-9._-] become "-", and leading or trailing dots
// are dropped so the result can never name the parent directory. It returns ""
// when nothing usable survives.
func SlugForThread(threadID string) string {
	var out strings.Builder
	out.Grow(len(threadID))
	for _, r := range threadID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			out.WriteRune(r)
		default:
			out.WriteRune('-')
		}
	}
	return strings.Trim(out.String(), ".")
}

// renderGuide produces the AGENTS.md/CLAUDE.md bytes for one binding. It reads
// only the binding's display fields; the token is never in scope here.
func renderGuide(b Binding) ([]byte, error) {
	raw, err := assets.ReadFile("assets/AGENTS.md")
	if err != nil {
		return nil, err
	}
	return []byte(strings.ReplaceAll(string(raw), targetPlaceholder, describeTarget(b))), nil
}

// describeTarget names the bound host for the guide's opening paragraph,
// degrading gracefully when the connection carries no label or address.
func describeTarget(b Binding) string {
	target := b.Host
	if b.Host != "" && b.User != "" {
		target = b.User + "@" + b.Host
	}
	switch {
	case target != "" && b.Label != "":
		return b.Label + " (`" + target + "`)"
	case target != "":
		return "`" + target + "`"
	case b.Label != "":
		return b.Label
	default:
		return "not reported — run `devdeck-ssh exec hostname` to see where you are"
	}
}

// writeFile replaces path's contents and reasserts mode 0600, which a plain
// os.WriteFile would leave alone on an already-existing file.
func writeFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, fileMode); err != nil {
		return err
	}
	return os.Chmod(path, fileMode)
}
