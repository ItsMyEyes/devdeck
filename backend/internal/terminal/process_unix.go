//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package terminal

import (
	"syscall"
	"time"

	crosspty "github.com/aymanbagabas/go-pty"
)

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func terminateProcess(cmd *crosspty.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// The Unix PTY command starts a new session, making pid the process group
	// id. Signal the group so child processes do not survive their terminal.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	_ = syscall.Kill(pid, syscall.SIGTERM)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = syscall.Kill(pid, syscall.SIGKILL)
}
