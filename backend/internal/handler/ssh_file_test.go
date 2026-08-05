package handler

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/sshmgr"
)

// This is SSHFileHandler's first test file. SSHFileHandler wraps a concrete
// *service.SSHFileService (no interface to fake), and that service talks to
// a real pooled SFTP connection — so, mirroring
// internal/service/ssh_file_test.go's own header comment (its fixture lives
// in a `_test.go` file and so isn't importable across packages), this file
// builds its own minimal in-process SSH/SFTP-only server: no exec subsystem,
// since Extract never shells out.

type sshFileHandlerConnStore struct {
	conn domain.SSHConnection
}

func (f *sshFileHandlerConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	return f.conn, nil
}

func (f *sshFileHandlerConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	f.conn.HostKeyFingerprint = fingerprint
	return nil
}

type sshFileHandlerSecrets map[string]string

func (f sshFileHandlerSecrets) Get(connectionID, kind string) (string, bool, error) {
	v, ok := f[kind]
	return v, ok, nil
}

// startTestSSHFileHandlerServer runs a minimal in-process SSH server
// (password auth only, user "tester" / password "secret") that serves
// homeDir as its SFTP working directory — just enough for
// SSHFileHandler.Extract's SFTP-only round trip.
func startTestSSHFileHandlerServer(t *testing.T, homeDir string) (addr string) {
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
			go serveTestSSHFileHandlerConn(nc, cfg, homeDir)
		}
	}()
	return ln.Addr().String()
}

func serveTestSSHFileHandlerConn(nc net.Conn, cfg *ssh.ServerConfig, homeDir string) {
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
		go serveTestSSHFileHandlerSession(ch, chReqs, homeDir)
	}
}

type sshFileHandlerSubsystemRequestMsg struct {
	Name string
}

// serveTestSSHFileHandlerSession services one "session" channel: only
// "subsystem" (sftp) requests are handled, served by pkg/sftp's real server
// implementation rooted at homeDir.
func serveTestSSHFileHandlerSession(ch ssh.Channel, reqs <-chan *ssh.Request, homeDir string) {
	for req := range reqs {
		switch req.Type {
		case "subsystem":
			var msg sshFileHandlerSubsystemRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil && msg.Name == "sftp"
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestSSHFileHandlerSFTP(ch, homeDir)
			} else {
				_ = ch.Close()
			}
			return
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

func runTestSSHFileHandlerSFTP(ch ssh.Channel, homeDir string) {
	defer ch.Close()
	server, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(homeDir))
	if err != nil {
		return
	}
	_ = server.Serve()
	_ = server.Close()
}

// newExtractTestSSHHandler wires a real SSHFileHandler (backed by a real
// SSHFileService over the fixture server above) with an existing "dest"
// folder to extract into — same fixture shape as
// internal/service/ssh_file_test.go's newExtractTestSSHConnection and
// worktree_file_test.go's newExtractTestHandler.
func newExtractTestSSHHandler(t *testing.T) (h *SSHFileHandler, connectionID, homeDir string) {
	t.Helper()
	homeDir = t.TempDir()
	if err := os.MkdirAll(filepath.Join(homeDir, "dest"), 0o755); err != nil {
		t.Fatal(err)
	}

	addr := startTestSSHFileHandlerServer(t, homeDir)
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	conn := domain.SSHConnection{ID: "sc-test", Name: "test", Host: host, Port: port, Username: "tester", AuthType: "password"}

	store := &sshFileHandlerConnStore{conn: conn}
	pool := sshmgr.NewFilePool(sshmgr.NewDialer(store, sshFileHandlerSecrets{"password": "secret"}))
	t.Cleanup(func() { pool.Evict("sc-test") })

	return NewSSHFileHandler(service.NewSSHFileService(pool)), "sc-test", homeDir
}

// buildTestZip builds an in-memory zip archive from name -> content pairs,
// same helper shape as worktree_file_test.go's copy in this package
// (unexported, one per package, matching that file's own precedent of a
// duplicated small fixture rather than a cross-file rename).
func sshExtractBuildTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if content != "" {
			if _, err := w.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// sshExtractRequest builds a multipart/form-data POST carrying the archive
// bytes as an "archive" file part and destPath as a "path" form field — the
// exact shape Extract's handler documents, same as
// worktree_file_test.go's extractRequest.
func sshExtractRequest(t *testing.T, connectionID, destPath string, archive []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("path", destPath); err != nil {
		t.Fatal(err)
	}
	part, err := mw.CreateFormFile("archive", "selection.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connectionID+"/files/extract", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("id", connectionID)
	return req
}

func TestSSHFileHandlerExtractWritesNestedEntriesAndReturnsEntries(t *testing.T) {
	h, connectionID, homeDir := newExtractTestSSHHandler(t)
	archive := sshExtractBuildTestZip(t, map[string]string{
		"README.md":          "hello",
		"src/nested/main.go": "package main",
	})

	rec := httptest.NewRecorder()
	h.Extract(rec, sshExtractRequest(t, connectionID, "dest", archive))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var entries []service.SSHFileEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("Extract response had no entries")
	}

	data, err := os.ReadFile(filepath.Join(homeDir, "dest", "README.md"))
	if err != nil || string(data) != "hello" {
		t.Fatalf("dest/README.md = %q, %v, want %q", data, err, "hello")
	}
	data, err = os.ReadFile(filepath.Join(homeDir, "dest", "src", "nested", "main.go"))
	if err != nil || string(data) != "package main" {
		t.Fatalf("dest/src/nested/main.go = %q, %v, want %q", data, err, "package main")
	}
}

// TestSSHFileHandlerExtractRejectsMaliciousArchivesWithTheErrorEnvelope
// mirrors WorktreeFileHandler's identically-named test: every zip-slip/
// symlink rejection case reaches the wire as {"error": "..."} with a 400,
// and nothing is written to the destination.
func TestSSHFileHandlerExtractRejectsMaliciousArchivesWithTheErrorEnvelope(t *testing.T) {
	symlinkArchive := func(t *testing.T) []byte {
		t.Helper()
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		header := &zip.FileHeader{Name: "escape-link"}
		header.SetMode(os.ModeSymlink | 0o777)
		w, err := zw.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("../../etc/passwd")); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}

	tests := []struct {
		name    string
		archive func(t *testing.T) []byte
	}{
		{"parent traversal", func(t *testing.T) []byte { return sshExtractBuildTestZip(t, map[string]string{"../x": "no"}) }},
		{"absolute path", func(t *testing.T) []byte { return sshExtractBuildTestZip(t, map[string]string{"/abs/x": "no"}) }},
		{"nested traversal", func(t *testing.T) []byte { return sshExtractBuildTestZip(t, map[string]string{"a/../../x": "no"}) }},
		{"symlink entry", symlinkArchive},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, connectionID, homeDir := newExtractTestSSHHandler(t)

			rec := httptest.NewRecorder()
			h.Extract(rec, sshExtractRequest(t, connectionID, "dest", tt.archive(t)))

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"error"`)) {
				t.Errorf("body = %q, want the {\"error\":...} envelope", got)
			}
			entries, err := os.ReadDir(filepath.Join(homeDir, "dest"))
			if err != nil {
				t.Fatalf("read dest: %v", err)
			}
			if len(entries) != 0 {
				t.Errorf("dest not empty after rejected Extract: %v", entries)
			}
		})
	}
}

// TestSSHFileHandlerExtractRequiresArchivePart proves a request missing the
// "archive" file part is rejected with the standard envelope rather than
// panicking on a nil MultipartForm.File lookup — mirrors
// WorktreeFileHandler's identically-named test. A nil-pool handler is enough
// here: this rejection happens before the handler ever touches the SSH pool.
func TestSSHFileHandlerExtractRequiresArchivePart(t *testing.T) {
	h := NewSSHFileHandler(service.NewSSHFileService(nil))

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("path", "dest"); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/sc-test/files/extract", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("id", "sc-test")

	rec := httptest.NewRecorder()
	h.Extract(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"error"`)) {
		t.Errorf("body = %q, want the {\"error\":...} envelope", got)
	}
}
