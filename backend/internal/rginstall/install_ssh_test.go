package rginstall

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/sshmgr"
)

// This package builds its own in-process SSH+SFTP test server rather than
// importing sshmgr's or service's equivalents: those live in _test.go
// files, which Go scopes to their own package's test binary only (same
// reasoning internal/service/ssh_file_test.go documents for its own copy).

type fakeRginstallConnStore struct {
	conn domain.SSHConnection
}

func (f *fakeRginstallConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	return f.conn, nil
}

func (f *fakeRginstallConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	f.conn.HostKeyFingerprint = fingerprint
	return nil
}

type fakeRginstallSecrets map[string]string

func (f fakeRginstallSecrets) Get(connectionID, kind string) (string, bool, error) {
	v, ok := f[kind]
	return v, ok, nil
}

// writeFakeUname writes a tiny shell script named "uname" into a fresh temp
// dir that unconditionally prints output — used with a PATH override so
// InstallOverSSH's remote OS/arch probe is deterministic regardless of the
// real host running these tests.
func writeFakeUname(t *testing.T, output string) (binDir string) {
	t.Helper()
	binDir = t.TempDir()
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s' %q\n", output)
	if err := os.WriteFile(filepath.Join(binDir, "uname"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return binDir
}

// startTestRginstallSSHServer runs a minimal in-process SSH server (password
// auth, user "tester"/"secret"). "exec" requests run through the real local
// POSIX shell with PATH restricted to fakeUnamePath (so `uname -s -m`
// resolves to the fake script above); "subsystem" (sftp) requests are
// served by pkg/sftp's real server implementation rooted at homeDir, so
// client.Getwd() resolves to homeDir exactly like a real connection's SFTP
// home directory.
func startTestRginstallSSHServer(t *testing.T, homeDir, fakeUnamePath string) (addr string) {
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
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go serveTestRginstallConn(nc, cfg, homeDir, fakeUnamePath)
		}
	}()
	return ln.Addr().String()
}

func serveTestRginstallConn(nc net.Conn, cfg *ssh.ServerConfig, homeDir, fakeUnamePath string) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "only session channels in this fixture")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go serveTestRginstallSession(ch, chReqs, homeDir, fakeUnamePath)
	}
}

type rginstallExecRequestMsg struct {
	Command string
}

type rginstallExitStatusMsg struct {
	Status uint32
}

type rginstallSubsystemRequestMsg struct {
	Name string
}

func serveTestRginstallSession(ch ssh.Channel, reqs <-chan *ssh.Request, homeDir, fakeUnamePath string) {
	for req := range reqs {
		switch req.Type {
		case "exec":
			var msg rginstallExecRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestRginstallExec(ch, msg.Command, fakeUnamePath)
			} else {
				_ = ch.Close()
			}
			return // exec is one-shot: no further requests follow on this channel
		case "subsystem":
			var msg rginstallSubsystemRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil && msg.Name == "sftp"
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestRginstallSFTP(ch, homeDir)
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

func runTestRginstallExec(ch ssh.Channel, command, fakeUnamePath string) {
	defer ch.Close()
	cmd := exec.Command("sh", "-c", command)
	if fakeUnamePath != "" {
		cmd.Env = []string{"PATH=" + fakeUnamePath}
	}
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
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(rginstallExitStatusMsg{Status: uint32(status)}))
}

func runTestRginstallSFTP(ch ssh.Channel, homeDir string) {
	defer ch.Close()
	server, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(homeDir))
	if err != nil {
		return
	}
	_ = server.Serve()
	_ = server.Close()
}

func newTestRginstallConn(addr string) domain.SSHConnection {
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	return domain.SSHConnection{ID: "sc-test", Name: "test", Host: host, Port: port, Username: "tester", AuthType: "password"}
}

func newTestRginstallPool(t *testing.T, addr string) *sshmgr.FilePool {
	t.Helper()
	store := &fakeRginstallConnStore{conn: newTestRginstallConn(addr)}
	pool := sshmgr.NewFilePool(sshmgr.NewDialer(store, fakeRginstallSecrets{"password": "secret"}))
	t.Cleanup(func() { pool.Evict("sc-test") })
	return pool
}

// serveGithubAPIAndAsset stands up one httptest.Server serving both the
// "latest release" API response and the release asset download, and
// registers it as the package's GitHub API base URL for t's duration.
func serveGithubAPIAndAsset(t *testing.T, assetName string, archive []byte) {
	t.Helper()
	var assetURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/BurntSushi/ripgrep/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tag_name":"15.2.0","assets":[{"name":%q,"browser_download_url":%q}]}`, assetName, assetURL)
	})
	mux.HandleFunc("/download/asset", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(archive)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	assetURL = srv.URL + "/download/asset"
	setGithubAPIBaseURL(t, srv.URL)
}

func TestInstallOverSSHDownloadsExtractsAndWritesToRemoteHome(t *testing.T) {
	tarball := buildTestTarGz(t, map[string]string{
		"ripgrep-15.2.0-x86_64-unknown-linux-musl/rg": "fake-remote-rg-binary",
	})
	serveGithubAPIAndAsset(t, "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz", tarball)

	homeDir := t.TempDir()
	fakeUname := writeFakeUname(t, "Linux x86_64")
	addr := startTestRginstallSSHServer(t, homeDir, fakeUname)
	pool := newTestRginstallPool(t, addr)

	version, err := InstallOverSSH(context.Background(), pool, "sc-test")
	if err != nil {
		t.Fatalf("InstallOverSSH failed: %v", err)
	}
	if version != "15.2.0" {
		t.Errorf("version = %q, want 15.2.0", version)
	}

	installedPath := filepath.Join(homeDir, ".local", "bin", "rg")
	data, err := os.ReadFile(installedPath)
	if err != nil {
		t.Fatalf("read installed remote binary: %v", err)
	}
	if string(data) != "fake-remote-rg-binary" {
		t.Errorf("installed binary contents = %q, want the extracted rg contents", data)
	}
	info, err := os.Stat(installedPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("installed remote binary is not executable: mode=%v", info.Mode())
	}
}

func TestInstallOverSSHMapsDarwinArm64Uname(t *testing.T) {
	tarball := buildTestTarGz(t, map[string]string{
		"ripgrep-15.2.0-aarch64-apple-darwin/rg": "fake-darwin-arm64-rg",
	})
	serveGithubAPIAndAsset(t, "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz", tarball)

	homeDir := t.TempDir()
	fakeUname := writeFakeUname(t, "Darwin arm64")
	addr := startTestRginstallSSHServer(t, homeDir, fakeUname)
	pool := newTestRginstallPool(t, addr)

	if _, err := InstallOverSSH(context.Background(), pool, "sc-test"); err != nil {
		t.Fatalf("InstallOverSSH failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(homeDir, ".local", "bin", "rg")); err != nil {
		t.Fatalf("expected installed binary: %v", err)
	}
}

func TestInstallOverSSHRejectsUnrecognizedRemoteOS(t *testing.T) {
	homeDir := t.TempDir()
	fakeUname := writeFakeUname(t, "SunOS x86_64")
	addr := startTestRginstallSSHServer(t, homeDir, fakeUname)
	pool := newTestRginstallPool(t, addr)

	if _, err := InstallOverSSH(context.Background(), pool, "sc-test"); err == nil {
		t.Fatal("expected an error for an unrecognized remote OS, got nil")
	}
}

func TestInstallOverSSHRejectsUnrecognizedRemoteArch(t *testing.T) {
	homeDir := t.TempDir()
	fakeUname := writeFakeUname(t, "Linux mips64")
	addr := startTestRginstallSSHServer(t, homeDir, fakeUname)
	pool := newTestRginstallPool(t, addr)

	if _, err := InstallOverSSH(context.Background(), pool, "sc-test"); err == nil {
		t.Fatal("expected an error for an unrecognized remote architecture, got nil")
	}
}
