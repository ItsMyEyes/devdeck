package sshmgr

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
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
