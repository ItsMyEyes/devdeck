// Package sshmgr manages SSH connections to arbitrary external hosts — an
// interactive shell now; SFTP and port forwarding in later phases (see
// docs/superpowers/specs/2026-07-14-ssh-management-design.md). It is a
// sibling of internal/terminal, not an extension of it: sessions are backed
// by golang.org/x/crypto/ssh instead of a local PTY. Dial resolves
// JumpConnectionID chains (bastion hops) and honours ExecutorMachineID by
// opening the underlying TCP connection through that runtime's forward
// proxy — see executor.go, which is the whole of that routing.
package sshmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
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
	// machines and proxies resolve ExecutorMachineID routing (executor.go).
	// Both nil means "always dial from this process", which is what a
	// runtime-role backend and the older tests want — executorDialer falls
	// back to a direct dial rather than failing when either is missing.
	machines MachineSource
	proxies  ProxyStarter
}

func NewDialer(store ConnStore, secrets SecretSource) *Dialer {
	return &Dialer{store: store, secrets: secrets}
}

// WithExecutorRouting enables ExecutorMachineID routing, returning the same
// dialer for chaining at the wiring site. Separate from NewDialer so the
// existing constructor (and every test built on it) keeps working unchanged
// and hub-local dialing stays the default.
func (d *Dialer) WithExecutorRouting(machines MachineSource, proxies ProxyStarter) *Dialer {
	d.machines = machines
	d.proxies = proxies
	return d
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

// Describe returns a short "user@host:port (authType)" string for a saved
// connection, for the terminal's "[ssh connecting to ...]" banner — so the
// operator sees what's being attempted before the (possibly slow, possibly
// failing) handshake completes, instead of a blank pane until it does.
func (d *Dialer) Describe(connectionID string) (string, error) {
	conn, err := d.store.SSHConnectionByID(connectionID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s@%s:%d (%s)", conn.Username, conn.Host, conn.Port, conn.AuthType), nil
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
		// A jump chain already dictates where the final hop originates: the
		// bastion dials it. The chain's *first* hop is the one that honours
		// its own ExecutorMachineID, via the recursion below.
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
		dialer, err := d.executorDialer(ctx, conn)
		if err != nil {
			return nil, err
		}
		nc, err = dialer.DialContext(ctx, "tcp", addr)
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
		// The raw ssh error (e.g. "attempted methods [none]") doesn't say
		// who we dialed as or what auth type we offered — wrap it so the
		// terminal's [ssh error: ...] line is self-contained instead of
		// requiring a trip to the server log to know which connection and
		// auth type it belongs to.
		return nil, fmt.Errorf("connect to %s@%s as %s: %w", conn.Username, addr, conn.AuthType, err)
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
