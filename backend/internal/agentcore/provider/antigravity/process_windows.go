package antigravity

import (
	"os/exec"

	"devdeck/backend/internal/procgroup"
)

func prepareProcess(*exec.Cmd) {}

// Windows cannot send os.Interrupt to a non-console process.
func interruptProcess(cmd *exec.Cmd, job procgroup.Handle) { killProcess(cmd, job) }
func killProcess(cmd *exec.Cmd, job procgroup.Handle) {
	job.Terminate()
	_ = cmd.Process.Kill()
}
