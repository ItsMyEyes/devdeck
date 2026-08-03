//go:build windows

package main

import (
	"net"
	"os"
	"syscall"
	"testing"
)

// The restart bug this guards against is Windows-only in practice, and the
// error it hinges on is easy to get wrong: syscall.EADDRINUSE compiles on
// Windows but is an invented value no Winsock call returns. Assert against the
// error shape net.Listen really produces there — *net.OpError wrapping
// *os.SyscallError wrapping the Winsock errno (net/sock_posix.go).
func TestIsAddrInUseRecognizesTheWinsockErrno(t *testing.T) {
	err := &net.OpError{
		Op:  "listen",
		Net: "tcp",
		Err: os.NewSyscallError("bind", wsaeAddrInUse),
	}
	if !isAddrInUse(err) {
		t.Errorf("isAddrInUse(%v) = false, want true for WSAEADDRINUSE", err)
	}

	posix := &net.OpError{
		Op:  "listen",
		Net: "tcp",
		Err: os.NewSyscallError("bind", syscall.EADDRINUSE),
	}
	if isAddrInUse(posix) {
		t.Error("isAddrInUse matched syscall.EADDRINUSE; on Windows that is a POSIX-compatibility value no bind returns, so matching it would mean the real WSAEADDRINUSE check is missing")
	}
}
