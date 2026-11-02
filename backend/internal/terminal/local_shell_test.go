package terminal

import (
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestLocalTerminalUsesLoginShell(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS terminal login shell")
	}
	t.Setenv("SHELL", "/bin/zsh")
	cmd := buildSessionCmd("local-terminal-test", "", "", nil)
	if len(cmd.Args) != 2 || cmd.Args[1] != "-l" {
		t.Fatalf("expected zsh login shell, got %v", cmd.Args)
	}
}

func TestLocalTerminalColorEnvironment(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("COLORTERM", "")
	cmd := buildSessionCmd("local-terminal-test", "", "", nil)
	env := map[string]string{}
	for _, item := range cmd.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			env[key] = value
		}
	}
	if _, ok := env["NO_COLOR"]; ok {
		t.Error("local shell inherited NO_COLOR")
	}
	if env["COLORTERM"] != "truecolor" {
		t.Errorf("COLORTERM = %q, want truecolor", env["COLORTERM"])
	}
	if env["TERM"] != "xterm-256color" {
		t.Errorf("TERM = %q", env["TERM"])
	}
}

func TestWorktreeTerminalPreservesNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	cmd := buildSessionCmd("w-test", "", "", nil)
	if !slices.Contains(cmd.Environ(), "NO_COLOR=1") {
		t.Error("worktree shell lost NO_COLOR")
	}
}
