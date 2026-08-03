//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package main

import (
	"errors"
	"syscall"
)

// isAddrInUse reports whether a bind failed because another socket already
// holds that address — the transient condition during a restart handoff, as
// opposed to a permanent error worth exiting on.
func isAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
