//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package handler

import (
	"os/exec"
	"syscall"
)

// detachFromParent starts the replacement process in its own session, so it
// survives this process exiting instead of dying with its process group
// (mirrors terminal/process_unix.go's PTY child session handling).
func detachFromParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
