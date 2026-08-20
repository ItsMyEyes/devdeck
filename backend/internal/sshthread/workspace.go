// Package sshthread seeds the local workspace DevDeck hands to a coding agent
// when a chat thread is attached to an SSH connection.
//
// The workspace holds instructions, one binding file, and one shim, nothing
// else: the agent reaches the remote host through the devdeck-ssh command,
// never through this directory. Seeding is idempotent and runs on every session
// start, so the instruction text and the shim always match the binary that
// wrote them.
package sshthread

import (
	"embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"devdeck/backend/internal/sshtoolcli"
)

//go:embed assets/*.md
var assets embed.FS

// targetPlaceholder is the single substitution the workspace guide carries: the
// host this thread is bound to. Everything else in the guide is fixed text.
const targetPlaceholder = "{{TARGET}}"

const (
	dirMode  os.FileMode = 0o700
	fileMode os.FileMode = 0o600
	// shimMode is fileMode plus the execute bit — the shim is the one file in
	// a workspace that has to run, and it stays owner-only like the rest.
	shimMode os.FileMode = 0o700
)

// skillDir is where the agent looks for locally installed skills, in the layout
// detect.ReadSkills parses.
var skillDir = filepath.Join(".claude", "skills", "devops-ssh")

// binSubdir holds the devdeck-ssh shim and nothing else. It is what main.go
// prepends to the spawned agent's PATH; see BinDir.
const binSubdir = "bin"

// ErrEmptyThreadID is returned by Seed when the binding carries no usable
// thread id, since the thread id is what names the workspace directory.
var ErrEmptyThreadID = errors.New("sshthread: binding has no usable thread id")

// Binding is DevDeck's machine-readable description of the SSH connection one
// chat thread is attached to. It is written to .devdeck/session.json (mode
// 0600) for the devdeck-ssh tool CLI to load, and never rendered into any file
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
// It writes AGENTS.md and a byte-identical CLAUDE.md, the devops-ssh skill, the
// binding at .devdeck/session.json, and the bin/devdeck-ssh shim that forwards
// to hostExe (see writeShim). Existing files are overwritten and their modes
// reasserted, so it is safe to call on every session start.
//
// hostExe is the absolute path of the DevDeck executable that will serve the
// agent's tool calls — normally os.Executable() of the running hub. Pass "" to
// skip the shim; see writeShim for why that is a legitimate outcome rather than
// an error.
func Seed(root string, b Binding, hostExe string) (string, error) {
	slug := SlugForThread(b.ThreadID)
	if slug == "" {
		return "", ErrEmptyThreadID
	}
	dir := filepath.Join(root, slug)

	for _, sub := range []string{".", ".devdeck", skillDir, binSubdir} {
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
	if err := writeShim(dir, hostExe); err != nil {
		return "", err
	}
	return dir, nil
}

// BinDir names the directory inside a seeded workspace that holds the
// devdeck-ssh shim — what the caller prepends to a spawned agent's PATH.
func BinDir(workspace string) string {
	return filepath.Join(workspace, binSubdir)
}

// writeShim installs bin/devdeck-ssh, a two-line forwarder to
// `<hostExe> ssh-tool "$@"`.
//
// This shim is what keeps DevDeck a single executable. The seeded guide and
// skill tell the agent to run a bare `devdeck-ssh`; pointing that name at the
// hub's own binary through a generated script means there is no second helper to
// cross-compile for six targets, add to the Tauri bundle as another externalBin,
// sign, notarize, put on the operator's PATH, and keep version-matched with the
// hub it talks to. The instructions the agent reads do not change at all.
//
// hostExe must be absolute: the agent's working directory is this workspace, not
// the install root. Seed re-runs on every session start, so an upgraded or
// relocated install rewrites the shim rather than leaving a dangling path.
//
// An empty hostExe writes nothing. That happens when the caller could not
// resolve its own executable, and a shim pointing nowhere is strictly worse than
// no shim: "command not found" tells the agent (and the operator reading the
// transcript) the truth, while a broken forwarder reports a shell error from a
// path nobody recognises.
func writeShim(dir, hostExe string) error {
	if hostExe == "" {
		return nil
	}
	if runtime.GOOS == "windows" {
		// cmd.exe resolves a bare `devdeck-ssh` to the .cmd through PATHEXT,
		// but a bash-flavoured shell on the same machine (git-bash, MSYS —
		// what several agent CLIs spawn commands through) looks for the
		// extensionless file. Write both; they cannot collide, since cmd.exe
		// will not run a file with no executable extension.
		if err := writeFileMode(filepath.Join(dir, binSubdir, sshtoolcli.HelperName+".cmd"), cmdShim(hostExe), shimMode); err != nil {
			return err
		}
	}
	return writeFileMode(filepath.Join(dir, binSubdir, sshtoolcli.HelperName), shShim(hostExe), shimMode)
}

// shShim is the POSIX forwarder. `exec` replaces the shell process, so the
// agent's stdin (which `devdeck-ssh write` reads content from) and the exit code
// (which carries 2 and 77 as documented meanings) pass through untouched rather
// than being relayed by a wrapper that could lose either.
func shShim(hostExe string) []byte {
	return []byte("#!/bin/sh\n" +
		"# Generated by DevDeck on every session start — do not edit.\n" +
		"exec '" + strings.ReplaceAll(hostExe, "'", `'\''`) + "' " + sshtoolcli.Subcommand + " \"$@\"\n")
}

// cmdShim is the Windows forwarder. %* preserves the caller's own quoting, and
// the explicit `exit /b` is what propagates exit codes 2 and 77 out of the
// script instead of leaving the agent to read a bare success.
func cmdShim(hostExe string) []byte {
	return []byte("@echo off\r\n" +
		"rem Generated by DevDeck on every session start - do not edit.\r\n" +
		`"` + hostExe + `" ` + sshtoolcli.Subcommand + " %*\r\n" +
		"exit /b %errorlevel%\r\n")
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
	return writeFileMode(path, data, fileMode)
}

// writeFileMode is writeFile for a caller that needs a mode other than 0600 —
// only the shim, which has to be executable.
func writeFileMode(path string, data []byte, mode os.FileMode) error {
	if err := os.WriteFile(path, data, mode); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}
