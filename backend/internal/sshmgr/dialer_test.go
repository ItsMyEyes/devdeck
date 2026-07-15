package sshmgr

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"strconv"
	"testing"

	"golang.org/x/crypto/ssh"

	"loom/backend/internal/domain"
)

type fakeConnStore struct {
	conn domain.SSHConnection
	err  error
}

func (f *fakeConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	if f.err != nil {
		return domain.SSHConnection{}, f.err
	}
	return f.conn, nil
}

func (f *fakeConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	f.conn.HostKeyFingerprint = fingerprint
	return nil
}

type fakeSecrets map[string]string

func (f fakeSecrets) Get(connectionID, kind string) (string, bool, error) {
	v, ok := f[kind]
	return v, ok, nil
}

// fakeMultiConnStore backs jump-chain tests, where Dial needs to resolve
// more than one saved connection by ID. All connections share the same
// password secret ("secret") for simplicity.
type fakeMultiConnStore map[string]domain.SSHConnection

func (f fakeMultiConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	c, ok := f[id]
	if !ok {
		return domain.SSHConnection{}, fmt.Errorf("connection %s not found", id)
	}
	return c, nil
}

func (f fakeMultiConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	c := f[id]
	c.HostKeyFingerprint = fingerprint
	f[id] = c
	return nil
}

func strPtr(s string) *string { return &s }

func testConn(t *testing.T, addr string) domain.SSHConnection {
	t.Helper()
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	portNum, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return domain.SSHConnection{ID: "sc-test", Name: "test", Host: host, Port: portNum, Username: "tester", AuthType: "password"}
}

func TestDialPasswordAuthPinsHostKeyOnFirstConnect(t *testing.T) {
	addr, fingerprint := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	d := NewDialer(st, fakeSecrets{"password": "secret"})

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()
	if st.conn.HostKeyFingerprint == nil || *st.conn.HostKeyFingerprint != fingerprint {
		t.Errorf("pinned = %v, want %s", st.conn.HostKeyFingerprint, fingerprint)
	}
}

func TestDialAcceptsMatchingPinnedKey(t *testing.T) {
	addr, fingerprint := startTestSSHServer(t, nil)
	c := testConn(t, addr)
	c.HostKeyFingerprint = &fingerprint
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"password": "secret"})
	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial with matching pin: %v", err)
	}
	client.Close()
}

func TestDialBlocksChangedHostKey(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pinned := "SHA256:doesnotmatchanything"
	c := testConn(t, addr)
	c.HostKeyFingerprint = &pinned
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"password": "secret"})
	if _, err := d.Dial(context.Background(), "sc-test"); !errors.Is(err, ErrHostKeyChanged) {
		t.Errorf("err = %v, want ErrHostKeyChanged", err)
	}
}

func TestDialWrongPasswordFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	d := NewDialer(&fakeConnStore{conn: testConn(t, addr)}, fakeSecrets{"password": "wrong"})
	if _, err := d.Dial(context.Background(), "sc-test"); err == nil {
		t.Error("Dial with wrong password succeeded, want auth error")
	}
}

func TestDialMissingSecretFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	d := NewDialer(&fakeConnStore{conn: testConn(t, addr)}, fakeSecrets{})
	if _, err := d.Dial(context.Background(), "sc-test"); err == nil {
		t.Error("Dial with no stored password succeeded, want error")
	}
}

func TestDialPrivateKeyAuth(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := string(pem.EncodeToMemory(block))

	addr, _ := startTestSSHServer(t, sshPub)
	c := testConn(t, addr)
	c.AuthType = "privatekey"
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"privatekey": keyPEM})
	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial with private key: %v", err)
	}
	client.Close()
}

func TestDialThroughJumpConnection(t *testing.T) {
	targetAddr, _ := startTestSSHServer(t, nil)
	jumpAddr, _ := startTestSSHServer(t, nil)

	target := testConn(t, targetAddr)
	target.ID = "sc-target"
	target.JumpConnectionID = strPtr("sc-jump")
	jump := testConn(t, jumpAddr)
	jump.ID = "sc-jump"

	store := fakeMultiConnStore{"sc-target": target, "sc-jump": jump}
	d := NewDialer(store, fakeSecrets{"password": "secret"})

	client, err := d.Dial(context.Background(), "sc-target")
	if err != nil {
		t.Fatalf("Dial through jump connection: %v", err)
	}
	defer client.Close()

	// Confirms the handshake actually happened against the target server
	// (not the jump server) — TOFU pinning only fires on the connection
	// whose host key was verified, i.e. the target.
	if store["sc-target"].HostKeyFingerprint == nil {
		t.Error("target connection's host key was not pinned — handshake may not have reached it")
	}
	if store["sc-jump"].HostKeyFingerprint == nil {
		t.Error("jump connection's host key was not pinned — jump hop may not have dialed")
	}
}

func TestDialThroughJumpConnectionChainOfTwo(t *testing.T) {
	targetAddr, _ := startTestSSHServer(t, nil)
	midAddr, _ := startTestSSHServer(t, nil)
	entryAddr, _ := startTestSSHServer(t, nil)

	target := testConn(t, targetAddr)
	target.ID = "sc-target"
	target.JumpConnectionID = strPtr("sc-mid")
	mid := testConn(t, midAddr)
	mid.ID = "sc-mid"
	mid.JumpConnectionID = strPtr("sc-entry")
	entry := testConn(t, entryAddr)
	entry.ID = "sc-entry"

	store := fakeMultiConnStore{"sc-target": target, "sc-mid": mid, "sc-entry": entry}
	d := NewDialer(store, fakeSecrets{"password": "secret"})

	client, err := d.Dial(context.Background(), "sc-target")
	if err != nil {
		t.Fatalf("Dial through two-hop jump chain: %v", err)
	}
	client.Close()
}

func TestDialJumpConnectionCycleFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	a := testConn(t, addr)
	a.ID = "sc-a"
	a.JumpConnectionID = strPtr("sc-b")
	b := testConn(t, addr)
	b.ID = "sc-b"
	b.JumpConnectionID = strPtr("sc-a")

	store := fakeMultiConnStore{"sc-a": a, "sc-b": b}
	d := NewDialer(store, fakeSecrets{"password": "secret"})

	if _, err := d.Dial(context.Background(), "sc-a"); !errors.Is(err, ErrJumpChainCycle) {
		t.Errorf("err = %v, want ErrJumpChainCycle", err)
	}
}

func TestDialMissingJumpConnectionFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	c := testConn(t, addr)
	c.ID = "sc-target"
	c.JumpConnectionID = strPtr("sc-does-not-exist")

	store := fakeMultiConnStore{"sc-target": c}
	d := NewDialer(store, fakeSecrets{"password": "secret"})

	if _, err := d.Dial(context.Background(), "sc-target"); err == nil {
		t.Error("Dial with missing jump connection succeeded, want error")
	}
}
