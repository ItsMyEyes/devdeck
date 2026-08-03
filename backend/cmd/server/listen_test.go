package main

import (
	"net"
	"strings"
	"testing"
	"time"
)

// freeAddr binds an ephemeral port, closes it, and returns the address, so a
// test can name a port that was free a moment ago.
func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatalf("release the reserved port: %v", err)
	}
	return addr
}

// A restart hands the port from the outgoing process to the incoming one, and
// the two overlap: POST /api/self/restart spawns the replacement first and only
// then exits, so the old listener is still bound when the new process reaches
// its bind. The incoming process has to wait that overlap out instead of dying.
func TestListenWithRetryWaitsForTheOutgoingProcessToReleaseThePort(t *testing.T) {
	addr := freeAddr(t)
	outgoing, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("stand in for the outgoing process: %v", err)
	}
	const held = 400 * time.Millisecond
	go func() {
		time.Sleep(held)
		outgoing.Close()
	}()

	start := time.Now()
	l, err := listenWithRetry("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("listenWithRetry: %v, want it to wait for the port to free up", err)
	}
	defer l.Close()

	if waited := time.Since(start); waited < held {
		t.Errorf("bound after %v, before the outgoing listener closed at %v", waited, held)
	}
	if l.Addr().String() != addr {
		t.Errorf("bound %s, want %s", l.Addr(), addr)
	}
}

// The wait is bounded: a port genuinely owned by something else must still fail,
// and the message has to name the address so the operator can go find the owner.
func TestListenWithRetryGivesUpWhenThePortStaysBusy(t *testing.T) {
	addr := freeAddr(t)
	squatter, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("stand in for an unrelated process: %v", err)
	}
	defer squatter.Close()

	start := time.Now()
	l, err := listenWithRetry("tcp", addr, 300*time.Millisecond)
	if err == nil {
		l.Close()
		t.Fatal("listenWithRetry succeeded on a permanently occupied port")
	}
	if waited := time.Since(start); waited < 300*time.Millisecond {
		t.Errorf("gave up after %v, before the retry window elapsed", waited)
	}
	if !strings.Contains(err.Error(), addr) {
		t.Errorf("error = %q, want it to name %s", err, addr)
	}
}

// Only "address in use" is worth retrying. A malformed address will never
// become bindable, so it must fail at once rather than stall every startup by
// the length of the retry window.
func TestListenWithRetryFailsImmediatelyOnAnErrorRetryingCannotFix(t *testing.T) {
	start := time.Now()
	l, err := listenWithRetry("tcp", "127.0.0.1:not-a-port", 5*time.Second)
	if err == nil {
		l.Close()
		t.Fatal("listenWithRetry succeeded on an unparseable address")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Errorf("took %v to reject an unparseable address; only address-in-use should be retried", waited)
	}
}

func TestIsAddrInUseRecognizesARealBindConflict(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()

	_, err = net.Listen("tcp", l.Addr().String())
	if err == nil {
		t.Fatal("second listen on the same address succeeded; cannot test the conflict")
	}
	if !isAddrInUse(err) {
		t.Errorf("isAddrInUse(%v) = false, want true for a real bind conflict", err)
	}

	_, err = net.Listen("tcp", "127.0.0.1:not-a-port")
	if err == nil {
		t.Fatal("listen on an unparseable address succeeded")
	}
	if isAddrInUse(err) {
		t.Errorf("isAddrInUse(%v) = true, want false for a non-conflict error", err)
	}
}
