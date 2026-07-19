//go:build windows

package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// platformCommand wraps Windows batch shims (commonly produced by npm for
// codex, claude, and similar CLIs) in cmd.exe. Native .exe commands are
// launched directly in ConPTY.
func platformCommand(name string, args ...string) *exec.Cmd {
	ext := strings.ToLower(filepath.Ext(name))
	if ext != ".bat" && ext != ".cmd" {
		return exec.Command(name, args...)
	}

	shell := os.Getenv("COMSPEC")
	if shell == "" {
		shell = "cmd.exe"
	}
	cmd := exec.Command(shell)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: `/d /s /c "` + quoteCmdArg(name) + " " + joinCmdArgs(args) + `"`,
	}
	return cmd
}

func joinCmdArgs(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = quoteCmdArg(arg)
	}
	return strings.Join(quoted, " ")
}

// quoteCmdArg keeps cmd.exe metacharacters inside double quotes and doubles
// embedded quotes. Paths and task prompts originate from local DevDeck data.
func quoteCmdArg(arg string) string {
	return `"` + strings.ReplaceAll(arg, `"`, `""`) + `"`
}
