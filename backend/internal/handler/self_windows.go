//go:build windows

package handler

import (
	"os/exec"
	"syscall"
)

// detachFromParent starts the replacement process in its own process
// group, so it survives this process exiting.
func detachFromParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}
