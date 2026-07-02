//go:build !windows

package terminal

import "os/exec"

func platformCommand(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}
