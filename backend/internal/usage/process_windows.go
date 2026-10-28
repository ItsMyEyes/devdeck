//go:build windows

package usage

import "os/exec"

func prepareUsageProcess(*exec.Cmd)   {}
func terminateUsageProcess(*exec.Cmd) {}
