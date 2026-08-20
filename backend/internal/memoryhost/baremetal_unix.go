//go:build !windows

package memoryhost

import (
	"os/exec"
	"syscall"
	"time"
)

// setDetached puts the child in its own session (setsid), the same
// mechanism internal/terminal's PTY commands rely on — a SIGHUP or a
// terminal-wide signal delivered to DevDeck's own process group must not
// reach a server meant to keep running independently of it.
func setDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// processAlive mirrors internal/terminal/process_unix.go's own helper
// exactly — signal 0 checks existence without actually signaling anything.
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// terminateGracefully sends SIGTERM (hindsight-api is a uvicorn/FastAPI
// server, which handles it as a clean shutdown) and escalates to SIGKILL
// only if the process is still alive after grace.
func terminateGracefully(pid int, grace time.Duration) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
}
