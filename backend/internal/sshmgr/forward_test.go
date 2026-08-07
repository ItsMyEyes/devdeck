package sshmgr

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
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

// freePort reserves a port and immediately releases it, so a test can bind
// it deliberately. A FIXED bind port is the whole point for the restart test
// below: with BindPort 0 every supervisor run picks a fresh port, so a
// listener left behind by a superseded run could never collide with its
// successor and the bug would be invisible.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portStr, err := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

// waitForRunningAndSettle waits for a forward to reach "running" and then
// holds for settle, failing the moment it sees "failed". "failed" is terminal
// — the supervisor has already returned — so catching it at all is enough;
// the settle window exists only because the losing supervisor can write
// "running" microseconds before the winning one writes "failed", which a
// plain waitForStatus would race past.
func waitForRunningAndSettle(t *testing.T, f *Forwarder, id string, settle time.Duration) domain.SSHForwardState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last domain.SSHForwardState
	for time.Now().Before(deadline) {
		last = f.StateOf(id)
		if last.Status == "failed" {
			t.Fatalf("forward %s wedged at failed: %s", id, last.Error)
		}
		if last.Status == "running" {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if last.Status != "running" {
		t.Fatalf("forward %s status = %q (err %q), want \"running\"", id, last.Status, last.Error)
	}
	for settleDeadline := time.Now().Add(settle); time.Now().Before(settleDeadline); {
		if s := f.StateOf(id); s.Status == "failed" {
			t.Fatalf("forward %s fell to failed after reaching running: %s", id, s.Error)
		}
		time.Sleep(2 * time.Millisecond)
	}
	return last
}

// Stop-then-Start while the first supervisor is still inside runOnce (status
// "starting") must not wedge the rule at a spurious "address already in use"
// on a port nothing else is using. That is exactly the sequence
// handler.Patch runs when a *running* rule is edited, and it used to lose:
// Stop found entry.ln == nil (the old supervisor had not bound yet) and so
// closed nothing, the old supervisor then wrote its listener into the map
// entry the new Start had already replaced, and the new supervisor's own
// net.Listen hit EADDRINUSE — which isTerminalForwardErr correctly, but
// uselessly, treats as permanent.
func TestRestartWhileStartingConvergesToRunning(t *testing.T) {
	dialer, connID := newForwardTestDialer(t)
	target := echoServer(t)
	targetHost, targetPortStr, _ := net.SplitHostPort(target.Addr().String())
	targetPort, err := strconv.Atoi(targetPortStr)
	if err != nil {
		t.Fatal(err)
	}
	bindPort := freePort(t)

	f := NewForwarder(dialer)

	// Calibrate: time one clean start. The race window is "the supervisor has
	// finished dialing but has not bound yet", which lives inside that
	// interval, so sweeping the Stop delay across it finds the window on a
	// fast laptop and under -race alike — where a hard-coded microsecond
	// count would only ever land on the machine it was written on. A delay of
	// exactly 0 does NOT reproduce: the supervisor is still inside a
	// ctx-aware DialContext, which the cancel aborts cleanly.
	warmup := domain.SSHForward{
		ID: "rr-warmup", ConnectionID: connID, Mode: "local",
		BindHost: "127.0.0.1", BindPort: bindPort,
		TargetHost: targetHost, TargetPort: targetPort,
	}
	begun := time.Now()
	if _, err := f.Start(warmup); err != nil {
		t.Fatalf("warmup Start: %v", err)
	}
	for deadline := time.Now().Add(5 * time.Second); f.StateOf("rr-warmup").Status != "running"; {
		if time.Now().After(deadline) {
			t.Fatalf("warmup never reached running (status %q)", f.StateOf("rr-warmup").Status)
		}
		time.Sleep(50 * time.Microsecond)
	}
	window := time.Since(begun)
	if err := f.Stop("rr-warmup"); err != nil {
		t.Fatalf("warmup Stop: %v", err)
	}

	// A fresh id per iteration keeps each round independent; the shared fixed
	// bind port is what carries the collision between them.
	const iterations = 24
	for i := 0; i < iterations; i++ {
		id := fmt.Sprintf("rr-%d", i)
		rule := domain.SSHForward{
			ID: id, ConnectionID: connID, Mode: "local",
			BindHost: "127.0.0.1", BindPort: bindPort,
			TargetHost: targetHost, TargetPort: targetPort,
		}
		if _, err := f.Start(rule); err != nil {
			t.Fatalf("iteration %d: first Start: %v", i, err)
		}
		// Deliberately no wait for "running": Stop must land while the first
		// supervisor is still mid-runOnce, which is the window.
		time.Sleep(time.Duration(int64(window) * int64(i) / int64(iterations)))
		if err := f.Stop(id); err != nil {
			t.Fatalf("iteration %d: Stop: %v", i, err)
		}
		if _, err := f.Start(rule); err != nil {
			t.Fatalf("iteration %d: restart: %v", i, err)
		}
		state := waitForRunningAndSettle(t, f, id, 50*time.Millisecond)
		if state.BoundAddr == "" {
			t.Fatalf("iteration %d: running with an empty BoundAddr", i)
		}
		if err := f.Stop(id); err != nil {
			t.Fatalf("iteration %d: final Stop: %v", i, err)
		}
	}
}

// A host that briefly stops resolving (laptop sleep, Wi-Fi/VPN switch) is the
// canonical blip the reconnect loop exists for, so it must never be terminal.
// Go reports it as "no such host", which the terminal-substring list used to
// match on "no such" — meant for a deleted saved connection, but catching DNS
// too and stranding the forward at "failed" until a manual re-toggle.
func TestUnresolvableHostStaysRetryable(t *testing.T) {
	fp := "SHA256:never-reached"
	// .invalid is reserved by RFC 2606 and never resolves. Should a hijacking
	// resolver answer anyway, the dial fails with "connection refused"
	// instead — also non-terminal, so the assertion below still holds.
	store := &fakeConnStore{conn: domain.SSHConnection{
		ID: "c1", Host: "devdeck-no-such-host.invalid", Port: 22,
		Username: "tester", AuthType: "password", HostKeyFingerprint: &fp,
	}}
	dialer := NewDialer(store, fakeSecrets{"password": "secret"})

	f := NewForwarder(dialer)
	t.Cleanup(func() { _ = f.Stop("dns") })

	rule := domain.SSHForward{
		ID: "dns", ConnectionID: "c1", Mode: "dynamic",
		BindHost: "127.0.0.1", BindPort: 0,
	}
	if _, err := f.Start(rule); err != nil {
		t.Fatalf("Start: %v", err)
	}

	state := waitForStatus(t, f, "dns", "reconnecting")
	if state.Error == "" {
		t.Error("reconnecting state carries no error message")
	}
	// And it must STAY retryable — the backoff sleep is ~1s, so a supervisor
	// that reclassified the next attempt as terminal would show up here.
	time.Sleep(200 * time.Millisecond)
	if got := f.StateOf("dns").Status; got == "failed" {
		t.Errorf("status = %q; a DNS blip must stay retryable, not fail terminally", got)
	}
}

// The terminal-substring list has to separate "this will never work" from
// "the network blipped" — pinned here because the two live one line apart.
func TestIsTerminalForwardErrClassification(t *testing.T) {
	// A missing saved connection: store.ErrNotFound ("not found") and
	// fakeMultiConnStore's "connection %s not found" both spell it this way.
	for _, msg := range []string{
		"not found",
		"connection sc-gone not found",
		"unable to authenticate, attempted methods [none]",
		"listen tcp 127.0.0.1:8080: bind: address already in use",
	} {
		if !isTerminalForwardErr(fmt.Errorf("%s", msg)) {
			t.Errorf("isTerminalForwardErr(%q) = false, want true", msg)
		}
	}

	// A DNS failure, both as the resolver's own type and as the resolver
	// really produces it through a dial.
	dnsErr := &net.DNSError{Err: "no such host", Name: "devdeck-no-such-host.invalid", IsNotFound: true}
	if isTerminalForwardErr(dnsErr) {
		t.Errorf("isTerminalForwardErr(%v) = true; a DNS blip must stay retryable", dnsErr)
	}
	if _, err := net.LookupHost("devdeck-no-such-host.invalid"); err != nil {
		wrapped := fmt.Errorf("dial devdeck-no-such-host.invalid:22: %w", err)
		if !strings.Contains(wrapped.Error(), "no such host") {
			t.Skipf("resolver reported %v, not a name error; nothing to assert", err)
		}
		if isTerminalForwardErr(wrapped) {
			t.Errorf("isTerminalForwardErr(%v) = true; a DNS blip must stay retryable", wrapped)
		}
	}

	// And the plain blips, which were never terminal and must stay that way.
	for _, msg := range []string{
		"dial tcp 10.0.0.5:22: connect: connection refused",
		"dial tcp 10.0.0.5:22: i/o timeout",
		"ssh: disconnect, reason 11: bye",
	} {
		if isTerminalForwardErr(fmt.Errorf("%s", msg)) {
			t.Errorf("isTerminalForwardErr(%q) = true, want false", msg)
		}
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
