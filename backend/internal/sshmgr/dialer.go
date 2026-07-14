// Package sshmgr manages SSH connections to arbitrary external hosts — an
// interactive shell now; SFTP and port forwarding in later phases (see
// docs/superpowers/specs/2026-07-14-ssh-management-design.md). It is a
// sibling of internal/terminal, not an extension of it: sessions are backed
// by golang.org/x/crypto/ssh instead of a local PTY, and Phase 1 always
// executes on this process (ExecutorMachineID routing and jump-host
// chaining are later phases).
package sshmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"

	"loom/backend/internal/domain"
)

const dialTimeout = 10 * time.Second

// SecretSource decrypts a connection's stored credential of the given kind
// ("password" | "privatekey" | "passphrase"); ok is false when none is
// stored. Implemented by service.SSHSecretService.
type SecretSource interface {
	Get(connectionID, kind string) (string, bool, error)
}

// ConnStore is the slice of port.Store the dialer needs: reading a saved
// connection and pinning its TOFU host-key fingerprint.
type ConnStore interface {
	SSHConnectionByID(id string) (domain.SSHConnection, error)
	SetSSHHostKey(id string, fingerprint *string) error
}

// ErrHostKeyChanged means the host presented a key that does not match the
// connection's pinned fingerprint — possible MITM. The operator must
// explicitly accept the new key (POST /api/ssh/connections/{id}/accept-hostkey)
// before the next connect can proceed.
var ErrHostKeyChanged = errors.New("host key changed")

// Dialer opens authenticated ssh.Clients for saved connections.
type Dialer struct {
	store   ConnStore
	secrets SecretSource
}

func NewDialer(store ConnStore, secrets SecretSource) *Dialer {
	return &Dialer{store: store, secrets: secrets}
}

// Dial connects to the saved connection and completes the SSH handshake.
// TOFU host keys: an empty fingerprint is pinned on the first successful
// key exchange; a pinned fingerprint must match exactly or the dial fails
// with ErrHostKeyChanged.
func (d *Dialer) Dial(ctx context.Context, connectionID string) (*ssh.Client, error) {
	conn, err := d.store.SSHConnectionByID(connectionID)
	if err != nil {
		return nil, err
	}
	auth, err := d.authMethods(conn)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            conn.Username,
		Auth:            auth,
		HostKeyCallback: d.hostKeyCallback(conn),
		Timeout:         dialTimeout,
	}
	addr := net.JoinHostPort(conn.Host, fmt.Sprint(conn.Port))
	nc, err := (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	if err != nil {
		nc.Close()
		return nil, err
	}
	return ssh.NewClient(sc, chans, reqs), nil
}

func (d *Dialer) authMethods(conn domain.SSHConnection) ([]ssh.AuthMethod, error) {
	switch conn.AuthType {
	case "password":
		pw, ok, err := d.secrets.Get(conn.ID, "password")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("connection %s has no stored password", conn.ID)
		}
		return []ssh.AuthMethod{ssh.Password(pw)}, nil
	case "privatekey":
		keyPEM, ok, err := d.secrets.Get(conn.ID, "privatekey")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("connection %s has no stored private key", conn.ID)
		}
		passphrase, hasPassphrase, err := d.secrets.Get(conn.ID, "passphrase")
		if err != nil {
			return nil, err
		}
		var signer ssh.Signer
		if hasPassphrase && passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyPEM), []byte(passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyPEM))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return nil, fmt.Errorf("unsupported auth type %q", conn.AuthType)
}

// hostKeyCallback implements TOFU pinning against the connection's stored
// SHA256 fingerprint.
func (d *Dialer) hostKeyCallback(conn domain.SSHConnection) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)
		if conn.HostKeyFingerprint == nil || *conn.HostKeyFingerprint == "" {
			return d.store.SetSSHHostKey(conn.ID, &fp)
		}
		if *conn.HostKeyFingerprint != fp {
			return fmt.Errorf("%w: pinned %s, host presented %s — accept the new key from the SSH page to continue", ErrHostKeyChanged, *conn.HostKeyFingerprint, fp)
		}
		return nil
	}
}
