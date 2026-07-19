package dbdriver

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/port"
)

// tunnelDialTimeout bounds the TCP dial and SSH handshake to the bastion.
// Mirrors sshmgr's dialTimeout so a wedged bastion fails the same way on
// both paths instead of hanging a database request open.
const tunnelDialTimeout = 10 * time.Second

// OpenTunnel dials target ("host:port") through an SSH bastion described by t
// and returns the tunneled net.Conn plus a close function that tears down both
// the conn and the underlying SSH client.
//
// This is deliberately NOT sshmgr.Dialer. That dialer resolves a saved
// connection id through port.Store, decrypts its secrets itself, and pins the
// host key TOFU-style — writing a newly seen fingerprint back to the store on
// first contact. Here the credentials arrive already resolved in a
// port.TunnelDescriptor (assembled on the hub, possibly forwarded to a
// runtime that has no store row for the connection at all), and the pin is
// mandatory rather than trust-on-first-use: there is no store to write a new
// fingerprint to, and a database tunnel dialed without verification would
// create exactly the man-in-the-middle exposure the tunnel exists to prevent.
// So this file maps a descriptor to an *ssh.ClientConfig and nothing more, and
// ssh's insecure ignore-host-key callback must never be used here.
//
// t must never be logged — it carries a password or private key.
func OpenTunnel(ctx context.Context, t port.TunnelDescriptor, target string) (net.Conn, func() error, error) {
	// Checked before dialing: a tunnel with no pin cannot be verified at all,
	// so there is no point opening a socket to find that out.
	if t.HostKeyFingerprint == "" {
		return nil, nil, fmt.Errorf("ssh tunnel to %s has no pinned host key fingerprint; connect over SSH once to pin it", t.Host)
	}
	auth, err := tunnelAuthMethods(t)
	if err != nil {
		return nil, nil, err
	}

	cfg := &ssh.ClientConfig{
		User:            t.Username,
		Auth:            auth,
		HostKeyCallback: pinnedHostKeyCallback(t.HostKeyFingerprint),
		Timeout:         tunnelDialTimeout,
	}
	addr := net.JoinHostPort(t.Host, fmt.Sprint(t.Port))

	nc, err := (&net.Dialer{Timeout: tunnelDialTimeout}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("dial ssh tunnel host %s: %w", addr, err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("ssh handshake with %s@%s: %w", t.Username, addr, err)
	}
	client := ssh.NewClient(sc, chans, reqs)

	conn, err := client.DialContext(ctx, "tcp", target)
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("dial %s through ssh tunnel %s: %w", target, addr, err)
	}

	closeFn := func() error {
		connErr := conn.Close()
		clientErr := client.Close()
		if connErr != nil {
			return connErr
		}
		return clientErr
	}
	return conn, closeFn, nil
}

// tunnelAuthMethods maps the descriptor's auth type to ssh auth methods.
// An unrecognized type is an error rather than a silent fallback to "no
// auth", which would turn a typo into an unauthenticated dial attempt.
func tunnelAuthMethods(t port.TunnelDescriptor) ([]ssh.AuthMethod, error) {
	switch t.AuthType {
	case "password":
		if t.Password == "" {
			return nil, fmt.Errorf("ssh tunnel auth type password but no password supplied")
		}
		return []ssh.AuthMethod{ssh.Password(t.Password)}, nil
	case "privatekey":
		if t.PrivateKey == "" {
			return nil, fmt.Errorf("ssh tunnel auth type privatekey but no private key supplied")
		}
		var (
			signer ssh.Signer
			err    error
		)
		if t.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(t.PrivateKey), []byte(t.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(t.PrivateKey))
		}
		if err != nil {
			// The parse error names the key format, never the key bytes.
			return nil, fmt.Errorf("parse ssh tunnel private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return nil, fmt.Errorf("unsupported ssh tunnel auth type %q", t.AuthType)
}

// pinnedHostKeyCallback verifies the presented host key against the pinned
// SHA-256 fingerprint. Unlike sshmgr's TOFU callback there is no first-use
// acceptance path here: an unknown key is a failure.
func pinnedHostKeyCallback(pinned string) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		presented := ssh.FingerprintSHA256(key)
		if subtle.ConstantTimeCompare([]byte(pinned), []byte(presented)) != 1 {
			return fmt.Errorf("ssh tunnel host key mismatch: pinned %s, host presented %s", pinned, presented)
		}
		return nil
	}
}
