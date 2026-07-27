// This file holds the wizard's output: devdeck.yaml, the optional
// copy-this.md, and the summary block main.go prints after the Bubble Tea
// program has exited. Nothing here imports Bubble Tea — the wizard confirms,
// then calls Write once.
package setupui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"devdeck/backend/internal/config"
)

// CopyThisFileName is the file the operator pastes into the hub's Machines
// dialog. It sits beside devdeck.yaml.
const CopyThisFileName = "copy-this.md"

// fieldSep separates the connection line's three fields. A field containing it
// would split into four and be rejected by the hub, so ConnectionLine refuses
// such input rather than emitting a line that cannot be pasted.
const fieldSep = "|"

// Result is what Write put on disk. CopyThisPath and ConnectionLine are empty
// for a hub, which has no runtime identity to register anywhere.
type Result struct {
	ConfigPath     string
	CopyThisPath   string
	ConnectionLine string
}

// registersWithAHub reports whether a role produces a pasteable connection
// line. A pure hub does not: writing one would copy the hub's own key into a
// file whose entire purpose is to be pasted somewhere else.
func registersWithAHub(role string) bool {
	switch role {
	case "runtime", "both":
		return true
	default:
		return false
	}
}

// ConnectionLine builds the single `name|url|key` line the hub's Add machine
// dialog accepts. It enforces the same rules parseConnectionString applies in
// frontend/src/features/machines/connectionString.ts — exactly three non-empty
// fields and an absolute http(s) URL — so a line that reaches the operator is
// always one the hub will take.
func ConnectionLine(name, publicURL, key string) (string, error) {
	fields := []struct {
		label string
		value string
	}{
		{"machine name", strings.TrimSpace(name)},
		{"public URL", strings.TrimSpace(publicURL)},
		{"key", strings.TrimSpace(key)},
	}
	for _, f := range fields {
		if f.value == "" {
			return "", fmt.Errorf("connection line needs a %s", f.label)
		}
		if strings.Contains(f.value, fieldSep) {
			return "", fmt.Errorf("%s %q contains %q, which would split the connection line into more than three fields", f.label, f.value, fieldSep)
		}
		if strings.ContainsAny(f.value, "\r\n") {
			return "", fmt.Errorf("%s %q contains a line break; the connection line must be a single line", f.label, f.value)
		}
	}
	url := fields[1].value
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "", fmt.Errorf("public URL %q must start with http:// or https:// for the hub to accept it", url)
	}
	return fields[0].value + fieldSep + url + fieldSep + fields[2].value, nil
}

// Write persists the wizard's answers into dir: always devdeck.yaml, plus
// copy-this.md when this machine registers with a hub. Both files carry a live
// API key, so both are written 0600 (config.Write already enforces that for
// devdeck.yaml).
//
// Write is the wizard's only disk mutation and runs only after the review step
// is confirmed, which is what makes ctrl+c at any earlier point leave the
// filesystem untouched.
func Write(dir string, cfg *config.Config) (Result, error) {
	if cfg == nil {
		return Result{}, fmt.Errorf("setupui: nil config")
	}

	// Build the connection line before writing anything: an incomplete runtime
	// identity should fail with a clear message rather than leave a devdeck.yaml
	// behind and then error.
	var line string
	if registersWithAHub(cfg.Role) {
		var err error
		line, err = ConnectionLine(cfg.Machine.Name, cfg.Machine.PublicURL, cfg.Key)
		if err != nil {
			return Result{}, fmt.Errorf("role %s: %w", cfg.Role, err)
		}
	}

	res := Result{ConfigPath: filepath.Join(dir, config.FileName)}
	if err := config.Write(res.ConfigPath, cfg); err != nil {
		return Result{}, err
	}

	if line == "" {
		return res, nil
	}

	res.CopyThisPath = filepath.Join(dir, CopyThisFileName)
	res.ConnectionLine = line
	if err := os.WriteFile(res.CopyThisPath, []byte(copyThisBody(cfg, line)), 0o600); err != nil {
		return Result{}, fmt.Errorf("write %s: %w", res.CopyThisPath, err)
	}
	return res, nil
}

// copyThisBody wraps the connection line in just enough instruction that the
// file makes sense on its own, months later, on a machine whose operator has
// forgotten what it was for. The line sits alone on its own line so it can be
// selected and pasted without picking up prose.
func copyThisBody(cfg *config.Config, line string) string {
	var b strings.Builder
	b.WriteString("# DevDeck runtime connection\n\n")
	b.WriteString("Paste the line below into your hub's **Machines -> Add machine ->\n")
	b.WriteString("\"Have a connection string instead?\"** field:\n\n")
	b.WriteString("    " + line + "\n\n")
	b.WriteString("Format is `name|url|key`. The hub verifies it immediately by calling this\n")
	b.WriteString("machine's /api/whoami with that key, so a wrong key or an unreachable URL\n")
	b.WriteString("fails right away rather than registering a dead machine.\n\n")
	if cfg.Hub.URL != "" {
		b.WriteString("This machine also self-registers with " + cfg.Hub.URL + " on startup, so\n")
		b.WriteString("pasting this line is only needed if that registration does not appear.\n\n")
	}
	b.WriteString("This file contains a live API key. It is mode 0600 and gitignored — keep it\n")
	b.WriteString("that way, and delete it once the machine is registered.\n")
	return b.String()
}

// Summary is the block main.go prints to stdout after the Bubble Tea program
// exits. It is printed after, not during, so it survives the alternate screen
// buffer and stays pipeable and copy-pasteable.
func (r Result) Summary() string {
	var b strings.Builder
	b.WriteString("\n")
	fmt.Fprintf(&b, "  wrote %s\n", r.ConfigPath)
	if r.CopyThisPath != "" {
		fmt.Fprintf(&b, "  wrote %s\n", r.CopyThisPath)
	}
	if r.ConnectionLine != "" {
		b.WriteString("\nPaste this line into the hub -> Machines -> Add machine ->\n")
		b.WriteString("\"Have a connection string instead?\":\n\n")
		b.WriteString("  " + r.ConnectionLine + "\n")
	}
	b.WriteString("\nStart it with:  devdeck\n")
	return b.String()
}
