package sshmgr

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"
)

// startTestSSHServer runs a minimal in-process SSH server for tests — the
// standard way to exercise golang.org/x/crypto/ssh without a real host. It
// accepts password auth (user "tester" / password "secret") and, when
// authorizedKey is non-nil, public-key auth for exactly that key. Session
// channels ack pty-req/shell/window-change requests and echo stdin back to
// stdout. Returns the listener address and the host key's SHA256 fingerprint.
func startTestSSHServer(t *testing.T, authorizedKey ssh.PublicKey) (addr, fingerprint string) {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(md ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if md.User() == "tester" && string(pass) == "secret" {
				return nil, nil
			}
			return nil, fmt.Errorf("wrong credentials for %q", md.User())
		},
	}
	if authorizedKey != nil {
		want := string(authorizedKey.Marshal())
		cfg.PublicKeyCallback = func(md ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == want {
				return nil, nil
			}
			return nil, fmt.Errorf("unknown public key for %q", md.User())
		}
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go serveTestSSHConn(nc, cfg)
		}
	}()
	return ln.Addr().String(), ssh.FingerprintSHA256(hostSigner.PublicKey())
}

func serveTestSSHConn(nc net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			newCh.Reject(ssh.UnknownChannelType, "only session channels in tests")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func(chReqs <-chan *ssh.Request) {
			for req := range chReqs {
				if req.WantReply {
					ok := req.Type == "pty-req" || req.Type == "shell" || req.Type == "window-change"
					_ = req.Reply(ok, nil)
				}
			}
		}(chReqs)
		go func(ch ssh.Channel) {
			_, _ = io.Copy(ch, ch) // echo stdin -> stdout
			_ = ch.Close()
		}(ch)
	}
}
