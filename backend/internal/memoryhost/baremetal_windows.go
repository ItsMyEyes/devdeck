//go:build windows

package memoryhost

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// setDetached asks Windows to give the child its own process group, so a
// Ctrl+C delivered to DevDeck's own console does not also reach it.
func setDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// processAlive relies on a Windows-specific quirk of os.FindProcess: unlike
// POSIX (where it always succeeds regardless of whether the PID is real),
// Windows' implementation calls OpenProcess internally and returns an error
// for a PID that doesn't exist — enough for a liveness check with no extra
// dependency beyond the standard library.
func processAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	return err == nil && proc != nil
}

// terminateGracefully has no SIGTERM equivalent readily available without
// extra syscalls on Windows, so this is a direct Kill — best-effort, not
// graceful. grace is accepted only to keep the signature identical to the
// Unix build.
func terminateGracefully(pid int, _ time.Duration) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = proc.Kill()
}
