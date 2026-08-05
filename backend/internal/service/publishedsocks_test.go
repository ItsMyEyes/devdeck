package service

import (
	"encoding/binary"
	"net"
	"strconv"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

// fakeSOCKSStore is an in-memory PublishedSOCKSStore.
type fakeSOCKSStore struct {
	cfg domain.PublishedSOCKSConfig
	err error
}

func (f *fakeSOCKSStore) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	return f.cfg, f.err
}

func (f *fakeSOCKSStore) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	if f.err != nil {
		return f.err
	}
	f.cfg = cfg
	return nil
}

func newTestSOCKSService(t *testing.T) (*PublishedSOCKSService, *fakeSOCKSStore) {
	t.Helper()
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{Port: 1080}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })
	return svc, store
}

// socksConnect performs an RFC1928 handshake with RFC1929 user/pass auth and
// asks the proxy to CONNECT to target. It returns the reply code byte.
func socksConnect(t *testing.T, proxyAddr, password, target string) byte {
	t.Helper()
	conn, err := net.DialTimeout("tcp", proxyAddr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	// Greeting: version 5, 1 method, username/password.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	sel := make([]byte, 2)
	if _, err := conn.Read(sel); err != nil {
		t.Fatalf("read method selection: %v", err)
	}
	if sel[1] != 0x02 {
		t.Fatalf("server selected method %#x, want 0x02 (user/pass)", sel[1])
	}

	// RFC1929: ver=1, ulen=1, "d", plen, password.
	auth := []byte{0x01, 0x01, 'd', byte(len(password))}
	auth = append(auth, []byte(password)...)
	if _, err := conn.Write(auth); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	authResp := make([]byte, 2)
	if _, err := conn.Read(authResp); err != nil {
		t.Fatalf("read auth response: %v", err)
	}
	if authResp[1] != 0x00 {
		return 0xff // auth rejected — caller asserts on this
	}

	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target: %v", err)
	}
	port, _ := strconv.Atoi(portStr)
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write connect request: %v", err)
	}
	reply := make([]byte, 10)
	if _, err := conn.Read(reply); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	return reply[1]
}

// freePort returns a port that was free a moment ago.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestApplyEnableBindsAndAuthenticates(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	// A real upstream for the proxy to CONNECT to.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	port := freePort(t)
	status, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !status.Running {
		t.Fatalf("Running = false, want true (status %+v)", status)
	}
	if status.Key == "" {
		t.Fatal("Key is empty; enabling must generate one")
	}
	if store.cfg.Key != status.Key || !store.cfg.Enabled {
		t.Errorf("store not persisted: %+v", store.cfg)
	}

	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, status.Key, upstream.Addr().String()); code != 0x00 {
		t.Errorf("CONNECT reply = %#x, want 0x00 (succeeded)", code)
	}
}

func TestApplyRejectsWrongPassword(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)
	if _, err := svc.Apply(true, port, false); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, "not-the-key", "127.0.0.1:9"); code != 0xff {
		t.Errorf("reply = %#x, want 0xff (auth rejected)", code)
	}
}

func TestApplyDisableClosesListener(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	port := freePort(t)
	if _, err := svc.Apply(true, port, false); err != nil {
		t.Fatalf("enable: %v", err)
	}

	status, err := svc.Apply(false, 0, false)
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if status.Running || status.Enabled {
		t.Fatalf("status after disable = %+v, want stopped", status)
	}
	if store.cfg.Enabled {
		t.Error("store still says enabled")
	}
	if _, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second); err == nil {
		t.Error("port still accepts connections after disable")
	}
}

func TestApplyIsIdempotent(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)

	first, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	second, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	if first.Key != second.Key || first.BoundAddr != second.BoundAddr {
		t.Errorf("re-apply changed state:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

func TestApplyRotateKeyChangesKeyAndStillServes(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)
	first, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	second, err := svc.Apply(true, port, true)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if second.Key == first.Key {
		t.Fatal("rotateKey did not change the key")
	}
	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, first.Key, "127.0.0.1:9"); code != 0xff {
		t.Errorf("old key still accepted (reply %#x)", code)
	}
}

func TestApplyRejectsInvalidPort(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	if _, err := svc.Apply(true, 70000, false); err == nil {
		t.Fatal("Apply accepted port 70000, want error")
	}
}

func TestApplyPortConflictReturnsErrorNotPanic(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	// The blocker binds the wildcard, matching what bindLocked binds. A
	// loopback blocker (127.0.0.1:port) does NOT conflict with a wildcard
	// bind on Darwin/BSD — Go sets SO_REUSEADDR on listeners, and BSD lets a
	// wildcard and a more-specific address coexist under it, so this test
	// would pass on Linux and fail on macOS while proving nothing either way.
	blocker, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	busy := blocker.Addr().(*net.TCPAddr).Port

	if _, err := svc.Apply(true, busy, false); err == nil {
		t.Fatal("Apply succeeded on a busy port, want error")
	}
	if store.cfg.Enabled {
		t.Error("failed bind must not persist enabled=true")
	}
}

func TestStartIfEnabledBindsWhenStoredEnabled(t *testing.T) {
	port := freePort(t)
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{
		Enabled: true, Port: port, Key: "stored-key",
	}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })

	if err := svc.StartIfEnabled(); err != nil {
		t.Fatalf("StartIfEnabled: %v", err)
	}
	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, "stored-key", "127.0.0.1:9"); code == 0xff {
		t.Error("stored key was rejected after StartIfEnabled")
	}
}

func TestStartIfEnabledNoopWhenDisabled(t *testing.T) {
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{Enabled: false, Port: 1080}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	if err := svc.StartIfEnabled(); err != nil {
		t.Fatalf("StartIfEnabled: %v", err)
	}
	status, err := svc.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Running {
		t.Error("Running = true, want false when stored config is disabled")
	}
}
