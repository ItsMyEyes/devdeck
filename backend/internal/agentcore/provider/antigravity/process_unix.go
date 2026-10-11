//go:build !windows

package antigravity

import (
	"os/exec"
	"syscall"

	"devdeck/backend/internal/procgroup"
)

func prepareProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func interruptProcess(cmd *exec.Cmd, _ procgroup.Handle) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
}
func killProcess(cmd *exec.Cmd, _ procgroup.Handle) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}
