package sshmgr

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

// newForwardTestDialer wires a Dialer at an in-process SSH server.
func newForwardTestDialer(t *testing.T) (*Dialer, string) {
	t.Helper()
	addr, fingerprint := startTestSSHServer(t, nil)
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	port := 0
	for _, r := range portStr {
		port = port*10 + int(r-'0')
	}
	fp := fingerprint
	conn := domain.SSHConnection{
		ID: "c1", Host: host, Port: port, Username: "tester",
		AuthType: "password", HostKeyFingerprint: &fp,
	}
	store := &fakeConnStore{conn: conn}
	// fakeSecrets is keyed by kind only (see dialer_test.go) — "c1:password"
	// would silently miss.
	return NewDialer(store, fakeSecrets{"password": "secret"}), "c1"
}

// echoServer accepts connections and echoes everything back.
func echoServer(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln
}

func waitForStatus(t *testing.T, f *Forwarder, id, want string) domain.SSHForwardState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last domain.SSHForwardState
	for time.Now().Before(deadline) {
		last = f.StateOf(id)
		if last.Status == want {
			return last
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("status = %q (err %q), want %q", last.Status, last.Error, want)
	return last
}

func TestLocalForwardPipesBytes(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("f1") })

	rule := domain.SSHForward{
		ID: "f1", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "f1", "running")

	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "ping" {
		t.Errorf("read %q, want \"ping\"", buf)
	}
}

func TestStopClosesTheListener(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	rule := domain.SSHForward{
		ID: "f1", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	state := waitForStatus(t, f, "f1", "running")

	if err := f.Stop("f1"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := net.DialTimeout("tcp", state.BoundAddr, time.Second); err == nil {
		t.Error("forward port still accepts connections after Stop")
	}
	if got := f.StateOf("f1").Status; got != "off" {
		t.Errorf("status after Stop = %q, want \"off\"", got)
	}
}

func TestStopIsIdempotent(t *testing.T) {
	dialer, _ := newForwardTestDialer(t)
	f := NewForwarder(dialer)

	if err := f.Stop("never-started"); err != nil {
		t.Errorf("Stop on an unknown id returned %v, want nil", err)
	}
}

func TestDynamicForwardProxiesThroughSSH(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("d1") })

	rule := domain.SSHForward{
		ID: "d1", ConnectionID: connID, Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "d1", "running")

	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	// Greeting + no auth.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	sel := make([]byte, 2)
	if _, err := io.ReadFull(conn, sel); err != nil {
		t.Fatal(err)
	}
	host, portStr, _ := net.SplitHostPort(target.Addr().String())
	port := 0
	for _, r := range portStr {
		port = port*10 + int(r-'0')
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != 0x00 {
		t.Fatalf("SOCKS reply = %#x, want 0x00", reply[1])
	}
	if _, err := conn.Write([]byte("pong")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "pong" {
		t.Errorf("read %q through the SOCKS tunnel, want \"pong\"", buf)
	}
}

func TestStartRejectsInvalidRule(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)

	for name, rule := range map[string]domain.SSHForward{
		"unknown mode": {ID: "x", ConnectionID: connID, Mode: "sideways", BindPort: 1},
		"local without target": {
			ID: "x", ConnectionID: connID, Mode: "local", BindPort: 1,
		},
		"port out of range": {
			ID: "x", ConnectionID: connID, Mode: "dynamic", BindPort: 70000,
		},
	} {
		if _, err := f.Start(rule); err == nil {
			t.Errorf("%s: Start accepted an invalid rule", name)
		}
	}
}

func TestStartFailsTerminallyOnBadConnection(t *testing.T) {
	// An empty fakeMultiConnStore (dialer_test.go), not newForwardTestDialer's
	// fakeConnStore — that one ignores the requested id and always resolves,
	// so "no-such-connection" would never actually fail to look up.
	dialer := NewDialer(fakeMultiConnStore{}, fakeSecrets{"password": "secret"})
	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("bad") })

	rule := domain.SSHForward{
		ID: "bad", ConnectionID: "no-such-connection", Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	// Start may return the error directly or drive the supervisor to failed;
	// either is acceptable, but it must not sit in "reconnecting" forever.
	if _, err := f.Start(rule); err != nil {
		return
	}
	state := waitForStatus(t, f, "bad", "failed")
	if state.Error == "" {
		t.Error("failed state carries no error message")
	}
}

func TestLocalForwardSurvivesADeadTarget(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("f2") })

	// Port 9 (discard) on a host that refuses: every proxied connection fails.
	rule := domain.SSHForward{
		ID: "f2", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: "127.0.0.1", TargetPort: 1,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	state := waitForStatus(t, f, "f2", "running")

	// A failed proxied connection must not tear the forward down.
	for i := 0; i < 3; i++ {
		if c, err := net.DialTimeout("tcp", state.BoundAddr, time.Second); err == nil {
			_, _ = io.Copy(io.Discard, c)
			c.Close()
		}
	}
	if got := f.StateOf("f2").Status; got != "running" {
		t.Errorf("status = %q after failed proxied connections, want \"running\"", got)
	}
}

func TestStatesListsEveryActiveForward(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	f := NewForwarder(dialer)
	t.Cleanup(func() {
		_ = f.Stop("a")
		_ = f.Stop("b")
	})

	for _, id := range []string{"a", "b"} {
		rule := domain.SSHForward{
			ID: id, ConnectionID: connID, Mode: "dynamic",
			BindHost: "127.0.0.1", BindPort: 0,
		}
		if _, err := f.Start(rule); err != nil {
			t.Fatalf("Start %s: %v", id, err)
		}
	}
	waitForStatus(t, f, "a", "running")
	waitForStatus(t, f, "b", "running")

	states := f.States()
	if len(states) != 2 {
		t.Fatalf("States() returned %d entries, want 2", len(states))
	}
}
