// Package sshmgr manages SSH connections to arbitrary external hosts — an
// interactive shell now; SFTP and port forwarding in later phases (see
// docs/superpowers/specs/2026-07-14-ssh-management-design.md). It is a
// sibling of internal/terminal, not an extension of it: sessions are backed
// by golang.org/x/crypto/ssh instead of a local PTY. Dial resolves
// JumpConnectionID chains (bastion hops); ExecutorMachineID routing to a
// non-hub runtime is still a later phase — Dial always executes on this
// process regardless of ExecutorMachineID.
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

// ErrJumpChainCycle means a connection's JumpConnectionID chain loops back
// on itself. The handler layer also validates this on write, so this only
// fires for chains that became cyclic after the fact (e.g. concurrent edits).
var ErrJumpChainCycle = errors.New("jump connection chain forms a cycle")

// maxJumpChainDepth bounds how many bastion hops Dial will follow — mirrors
// handler.maxJumpChainDepth so writes and reads agree on the limit.
const maxJumpChainDepth = 8

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
//
// When the connection has a JumpConnectionID, Dial first resolves that
// connection (recursively — chains longer than one hop work for free) and
// tunnels the target handshake through the resulting *ssh.Client's own
// Dial, the standard nested-client bastion pattern. Each hop's tunneled
// client is closed automatically once the client it feeds into disconnects,
// so a multi-hop chain doesn't leak intermediate connections.
func (d *Dialer) Dial(ctx context.Context, connectionID string) (*ssh.Client, error) {
	return d.dial(ctx, connectionID, map[string]bool{})
}

func (d *Dialer) dial(ctx context.Context, connectionID string, visited map[string]bool) (*ssh.Client, error) {
	if visited[connectionID] {
		return nil, fmt.Errorf("%w at connection %s", ErrJumpChainCycle, connectionID)
	}
	if len(visited) >= maxJumpChainDepth {
		return nil, fmt.Errorf("jump connection chain exceeds max depth of %d", maxJumpChainDepth)
	}
	visited[connectionID] = true

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

	var nc net.Conn
	var jumpClient *ssh.Client
	if conn.JumpConnectionID != nil && *conn.JumpConnectionID != "" {
		jumpClient, err = d.dial(ctx, *conn.JumpConnectionID, visited)
		if err != nil {
			return nil, fmt.Errorf("dial jump connection: %w", err)
		}
		nc, err = jumpClient.Dial("tcp", addr)
		if err != nil {
			jumpClient.Close()
			return nil, fmt.Errorf("dial %s via jump host: %w", addr, err)
		}
	} else {
		nc, err = (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dial %s: %w", addr, err)
		}
	}

	sc, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	if err != nil {
		nc.Close()
		if jumpClient != nil {
			jumpClient.Close()
		}
		return nil, err
	}
	client := ssh.NewClient(sc, chans, reqs)
	if jumpClient != nil {
		// Tie the jump hop's lifetime to this hop's: once this client
		// disconnects (caller Close, or the transport dying on its own),
		// tear down the jump client too. Recurses naturally through
		// arbitrarily long chains since each hop wires only its own
		// immediate jump client this way.
		go func() {
			client.Wait()
			jumpClient.Close()
		}()
	}
	return client, nil
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
