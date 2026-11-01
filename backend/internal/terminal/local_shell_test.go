package terminal

import (
	"runtime"
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
