package sshmgr

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"testing"

	"github.com/pkg/sftp"
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

// directTCPIPMsg mirrors RFC 4254 §7.2's "direct-tcpip" channel-open extra
// data — what ssh.Client.Dial sends when tunneling through this server, e.g.
// via a jump-connection hop (see dialer.go's dial).
type directTCPIPMsg struct {
	DestAddr string
	DestPort uint32
	OrigAddr string
	OrigPort uint32
}

func serveTestSSHConn(nc net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		switch newCh.ChannelType() {
		case "session":
			ch, chReqs, err := newCh.Accept()
			if err != nil {
				continue
			}
			go serveTestSSHSession(ch, chReqs)
		case "direct-tcpip":
			// Makes this test server double as a jump/bastion host: proxy
			// the requested destination the way a real sshd would for
			// ssh.Client.Dial (used by jump-connection chaining tests).
			var msg directTCPIPMsg
			if err := ssh.Unmarshal(newCh.ExtraData(), &msg); err != nil {
				newCh.Reject(ssh.ConnectionFailed, "bad direct-tcpip payload")
				continue
			}
			target, err := net.Dial("tcp", net.JoinHostPort(msg.DestAddr, fmt.Sprint(msg.DestPort)))
			if err != nil {
				newCh.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			ch, chReqs, err := newCh.Accept()
			if err != nil {
				target.Close()
				continue
			}
			go ssh.DiscardRequests(chReqs)
			go func() {
				_, _ = io.Copy(target, ch)
				target.Close()
			}()
			go func() {
				_, _ = io.Copy(ch, target)
				ch.Close()
			}()
		default:
			newCh.Reject(ssh.UnknownChannelType, "only session/direct-tcpip channels in tests")
		}
	}
}

// execRequestMsg mirrors RFC 4254 §6.5's "exec" channel-request payload:
// the single command string the client wants the remote shell to run.
type execRequestMsg struct {
	Command string
}

// exitStatusMsg mirrors RFC 4254 §6.10's "exit-status" channel-request
// payload, sent back once a command finishes.
type exitStatusMsg struct {
	Status uint32
}

// serveTestSSHSession services one "session" channel. "shell" requests
// (used by the interactive-shell tests) keep the original echo-stdin-to-
// stdout behavior. "exec" requests (used by exec_test.go's non-interactive
// command-primitive tests) run the command through the *real* local POSIX
// shell via os/exec — this is what lets the shell-escaping test prove an
// argument survives a REAL shell's parsing unharmed, not a hand-rolled
// stand-in — and report real stdout/stderr/exit-status back over the
// channel, the same sequence a real sshd follows for an exec request.
func serveTestSSHSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	for req := range reqs {
		switch req.Type {
		case "pty-req", "window-change":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		case "shell":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			go func() {
				_, _ = io.Copy(ch, ch) // echo stdin -> stdout
				_ = ch.Close()
			}()
		case "exec":
			var msg execRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestSSHExec(ch, msg.Command)
			} else {
				_ = ch.Close()
			}
			return // exec is one-shot: no further requests follow on this channel
		case "subsystem":
			var msg subsystemRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil && msg.Name == "sftp"
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestSFTPSubsystem(ch)
			} else {
				_ = ch.Close()
			}
			return // subsystem is one-shot, same as exec
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

// runTestSSHExec runs command through the local shell, wires its stdout and
// stderr to the corresponding channel streams, sends the real exit-status
// back, and closes the channel.
func runTestSSHExec(ch ssh.Channel, command string) {
	defer ch.Close()
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdout = ch
	cmd.Stderr = ch.Stderr()
	runErr := cmd.Run()

	status := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			status = exitErr.ExitCode()
		} else {
			status = 1
		}
	}
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(exitStatusMsg{Status: uint32(status)}))
}

// subsystemRequestMsg mirrors RFC 4254 §6.5's "subsystem" channel-request
// payload: the subsystem name the client wants started on this channel.
type subsystemRequestMsg struct {
	Name string
}

// runTestSFTPSubsystem serves a real SFTP session over ch using pkg/sftp's
// server implementation — the same library the production client side
// (github.com/pkg/sftp) speaks — so FilePool.Get/WithSFTPClient-backed
// tests exercise a genuine SFTP handshake and protocol exchange instead of
// a hand-rolled stand-in.
func runTestSFTPSubsystem(ch ssh.Channel) {
	defer ch.Close()
	server, err := sftp.NewServer(ch)
	if err != nil {
		return
	}
	_ = server.Serve()
	_ = server.Close()
}
