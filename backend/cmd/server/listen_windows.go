//go:build windows

package main

import (
	"errors"
	"syscall"
)

// wsaeAddrInUse is Winsock's WSAEADDRINUSE, reported as "Only one usage of each
// socket address (protocol/network address/port) is normally permitted".
//
// syscall.EADDRINUSE cannot stand in for it: on Windows that name is an
// invented POSIX-compatibility value (syscall/zerrors_windows.go) that no
// Winsock call ever returns, and syscall.Errno.Is does not map the two. Nor can
// the message be matched as a string — Windows localizes it.
const wsaeAddrInUse = syscall.Errno(10048)

// isAddrInUse reports whether a bind failed because another socket already
// holds that address — the transient condition during a restart handoff, as
// opposed to a permanent error worth exiting on.
func isAddrInUse(err error) bool {
	return errors.Is(err, wsaeAddrInUse)
}
