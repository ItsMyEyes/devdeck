package sshmgr

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
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

// waitForBoundAddrChange polls until a running forward's BoundAddr differs
// from oldAddr, proving the supervisor actually re-listened — durable
// evidence a reconnect happened, unlike the transient "reconnecting"
// status, which a healthy local transport can pass through in under a
// millisecond (far too fast for any poll interval to reliably observe).
func waitForBoundAddrChange(t *testing.T, f *Forwarder, id, oldAddr string) domain.SSHForwardState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last domain.SSHForwardState
	for time.Now().Before(deadline) {
		last = f.StateOf(id)
		if last.Status == "running" && last.BoundAddr != "" && last.BoundAddr != oldAddr {
			return last
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("BoundAddr never changed from %q (status=%q, err=%q)", oldAddr, last.Status, last.Error)
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

func TestRemoteForwardPipesBytes(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("r1") })

	rule := domain.SSHForward{
		ID: "r1", ConnectionID: connID, Mode: "remote",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "r1", "running")

	// The test server bound a real local listener for the remote side, so
	// dialing BoundAddr enters the tunnel from the "remote" end.
	conn, err := net.Dial("tcp", state.BoundAddr)
	if err != nil {
		t.Fatalf("dial remote-forward port: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("back")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "back" {
		t.Errorf("read %q, want \"back\"", buf)
	}
}

func TestBackoffSequence(t *testing.T) {
	want := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		30 * time.Second, // capped
		30 * time.Second,
		30 * time.Second,
	}
	for i, w := range want {
		if got := backoffFor(i); got != w {
			t.Errorf("backoffFor(%d) = %v, want %v", i, got, w)
		}
	}
}

func TestBackoffNeverExceedsCap(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		if got := backoffFor(attempt); got > 30*time.Second {
			t.Fatalf("backoffFor(%d) = %v, exceeds the 30s cap", attempt, got)
		}
	}
}

func TestForwardReconnectsAfterTransportDies(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("rc") })

	rule := domain.SSHForward{
		ID: "rc", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	before := waitForStatus(t, f, "rc", "running")

	// Kill the underlying transport out from under the forward.
	f.closeClientForTest("rc")

	// Must come back on its own, at a NEW BoundAddr (BindPort:0 re-listens
	// from scratch on every reconnect) — proof the supervisor actually
	// re-ran runOnce, not just that the status field still reads "running"
	// (which it may never have visibly stopped doing, per the note above).
	waitForBoundAddrChange(t, f, "rc", before.BoundAddr)
}

// An auth failure (wrong password) must go straight to "failed" with zero
// retry attempts — never enter the backoff loop, which would hide a dead
// rule behind a hopeful "reconnecting" forever.
func TestAuthFailureGoesStraightToFailedWithoutRetrying(t *testing.T) {
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
	// The test server only accepts password "secret" (testserver_test.go).
	dialer := NewDialer(store, fakeSecrets{"password": "wrong"})

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("auth-fail") })

	rule := domain.SSHForward{
		ID: "auth-fail", ConnectionID: "c1", Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}
	state := waitForStatus(t, f, "auth-fail", "failed")
	if state.Attempts != 0 {
		t.Errorf("Attempts = %d, want 0 — an auth failure must not retry", state.Attempts)
	}
	if state.Error == "" {
		t.Error("failed state carries no error message")
	}
}

// breakableConnStore is a race-safe ConnStore fake whose port can be
// mutated mid-test (unlike fakeConnStore in dialer_test.go, which has no
// mutex and must not be mutated concurrently) — used to force a reconnect
// attempt to actually fail, so the forward stays in "reconnecting" for a
// real ~1s backoff window instead of racing past it in under a millisecond.
type breakableConnStore struct {
	mu   sync.Mutex
	conn domain.SSHConnection
}

func (s *breakableConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn, nil
}

func (s *breakableConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.HostKeyFingerprint = fingerprint
	return nil
}

func (s *breakableConnStore) breakPort() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.Port = 1 // nothing listens here; every future redial fails
}

// Stop must work from "reconnecting", not only from "running" — the
// backoff sleep must be interruptible, not just the steady state.
func TestStopFromReconnectingState(t *testing.T) {
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
	store := &breakableConnStore{conn: domain.SSHConnection{
		ID: "c1", Host: host, Port: port, Username: "tester",
		AuthType: "password", HostKeyFingerprint: &fp,
	}}
	dialer := NewDialer(store, fakeSecrets{"password": "secret"})

	f := NewForwarder(dialer)
	rule := domain.SSHForward{
		ID: "rs", ConnectionID: "c1", Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, f, "rs", "running")

	store.breakPort()
	f.closeClientForTest("rs")
	waitForStatus(t, f, "rs", "reconnecting")

	if err := f.Stop("rs"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if got := f.StateOf("rs").Status; got != "off" {
		t.Errorf("status after Stop from reconnecting = %q, want \"off\"", got)
	}
}

// Only possible now that Task 3's test server honours cancel-tcpip-forward
// — without that fix the remote port stays open after Stop.
func TestRemoteForwardStopClosesTheListener(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort := 0
	for _, r := range targetPortStr {
		targetPort = targetPort*10 + int(r-'0')
	}

	f := NewForwarder(dialer)
	rule := domain.SSHForward{
		ID: "r2", ConnectionID: connID, Mode: "remote",
		BindHost: "127.0.0.1", BindPort: 0,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatal(err)
	}
	state := waitForStatus(t, f, "r2", "running")

	if err := f.Stop("r2"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := net.DialTimeout("tcp", state.BoundAddr, time.Second); err == nil {
		t.Error("remote forward port still accepts connections after Stop")
	}
	if got := f.StateOf("r2").Status; got != "off" {
		t.Errorf("status after Stop = %q, want \"off\"", got)
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
