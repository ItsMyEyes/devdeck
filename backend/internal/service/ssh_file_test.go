package service

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/sshmgr"
)

// This is SSHFileService's first test file. There is no existing in-process
// SSH server fixture importable here: sshmgr/testserver_test.go's
// startTestSSHServer lives in a `_test.go` file, which Go scopes to that
// package's own test binary only — it cannot be imported across packages.
// So this file builds an equivalent real (non-mocked) in-process SSH server,
// mirroring that fixture's exec + sftp subsystem handling, parameterized by
// an SFTP home directory and an optional PATH override (used to
// deterministically simulate "rg not installed" regardless of whether the
// machine actually running these tests has ripgrep on its PATH).

// fakeSSHFileConnStore/fakeSSHFileSecrets satisfy sshmgr.ConnStore/
// sshmgr.SecretSource for a single fixed "sc-test" connection, mirroring
// sshmgr/dialer_test.go's fakeConnStore/fakeSecrets (also unexported and
// package-private, so redefined here rather than imported).
type fakeSSHFileConnStore struct {
	conn domain.SSHConnection
}

func (f *fakeSSHFileConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	return f.conn, nil
}

func (f *fakeSSHFileConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	f.conn.HostKeyFingerprint = fingerprint
	return nil
}

type fakeSSHFileSecrets map[string]string

func (f fakeSSHFileSecrets) Get(connectionID, kind string) (string, bool, error) {
	v, ok := f[kind]
	return v, ok, nil
}

// startTestSSHFileServer runs a minimal in-process SSH server (password auth
// only, user "tester" / password "secret") that serves homeDir as its SFTP
// working directory (so client.Getwd() — and therefore SSHFileService.Grep's
// search root — resolves to homeDir) and, when pathOverride is non-empty,
// restricts every exec session's PATH to pathOverride only.
func startTestSSHFileServer(t *testing.T, homeDir, pathOverride string) (addr string) {
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
			go serveTestSSHFileConn(nc, cfg, homeDir, pathOverride)
		}
	}()
	return ln.Addr().String()
}

func serveTestSSHFileConn(nc net.Conn, cfg *ssh.ServerConfig, homeDir, pathOverride string) {
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
		go serveTestSSHFileSession(ch, chReqs, homeDir, pathOverride)
	}
}

// sshFileExecRequestMsg/sshFileExitStatusMsg/sshFileSubsystemRequestMsg
// mirror RFC 4254 §6.5/§6.10's exec/exit-status/subsystem channel-request
// payloads — same shapes sshmgr/testserver_test.go uses, redefined here
// since that file's types aren't importable either.
type sshFileExecRequestMsg struct {
	Command string
}

type sshFileExitStatusMsg struct {
	Status uint32
}

type sshFileSubsystemRequestMsg struct {
	Name string
}

// serveTestSSHFileSession services one "session" channel: "exec" requests
// run the command through the real local POSIX shell (proving arguments
// survive a genuine shell's parsing, not a hand-rolled stand-in), "subsystem"
// (sftp) requests are served by pkg/sftp's real server implementation rooted
// at homeDir.
func serveTestSSHFileSession(ch ssh.Channel, reqs <-chan *ssh.Request, homeDir, pathOverride string) {
	for req := range reqs {
		switch req.Type {
		case "exec":
			var msg sshFileExecRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestSSHFileExec(ch, msg.Command, pathOverride)
			} else {
				_ = ch.Close()
			}
			return // exec is one-shot: no further requests follow on this channel
		case "subsystem":
			var msg sshFileSubsystemRequestMsg
			ok := ssh.Unmarshal(req.Payload, &msg) == nil && msg.Name == "sftp"
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
			if ok {
				runTestSSHFileSFTP(ch, homeDir)
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

// testSSHExecCount counts every exec session the fixture server has served,
// so a test can assert how many *remote commands* an operation costs — the
// property that makes remote search fast or unusable. Tests that read it call
// resetTestSSHExecCount first; none of them run in parallel.
var testSSHExecCount atomic.Int64

func resetTestSSHExecCount() { testSSHExecCount.Store(0) }

// runTestSSHFileExec runs command through the local shell, wires its real
// stdout/stderr to the channel, and sends a real exit-status back — this is
// what makes the shell-metacharacter-safety tests below meaningful: a
// genuine shell parses the delivered command string, not a stand-in. When
// pathOverride is non-empty, PATH is replaced entirely so `command -v rg`
// deterministically fails regardless of what's actually installed on the
// host running these tests.
func runTestSSHFileExec(ch ssh.Channel, command, pathOverride string) {
	defer ch.Close()
	testSSHExecCount.Add(1)
	cmd := exec.Command("sh", "-c", command)
	if pathOverride != "" {
		cmd.Env = []string{"PATH=" + pathOverride}
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
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(sshFileExitStatusMsg{Status: uint32(status)}))
}

// runTestSSHFileSFTP serves a real SFTP session over ch using pkg/sftp's
// server implementation, rooted at homeDir via WithServerWorkingDirectory —
// so client.Getwd() (SFTP's RealPath(".")) resolves to homeDir exactly like
// remoteAbsPath/SSHFileService.Grep expect a connection's home directory to
// behave.
func runTestSSHFileSFTP(ch ssh.Channel, homeDir string) {
	defer ch.Close()
	server, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(homeDir))
	if err != nil {
		return
	}
	_ = server.Serve()
	_ = server.Close()
}

func newTestSSHFileConn(addr string) domain.SSHConnection {
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	return domain.SSHConnection{ID: "sc-test", Name: "test", Host: host, Port: port, Username: "tester", AuthType: "password"}
}

func newTestSSHFilePool(t *testing.T, addr string) *sshmgr.FilePool {
	t.Helper()
	store := &fakeSSHFileConnStore{conn: newTestSSHFileConn(addr)}
	pool := sshmgr.NewFilePool(sshmgr.NewDialer(store, fakeSSHFileSecrets{"password": "secret"}))
	t.Cleanup(func() { pool.Evict("sc-test") })
	return pool
}

// newGrepTestSSHConnection mirrors worktree_file_test.go's
// newGrepTestWorktree exactly (same fixture content: a TODO comment in
// src/main.go, a TODO in README.md, and a TODO inside node_modules/ + .git/
// that must never appear in results) but serves it over the in-process SSH
// server above instead of a local worktree, so both Grep implementations are
// proven against the same content/skip-dir expectations. pathOverride is
// forwarded to startTestSSHFileServer ("" keeps the real PATH so tests can
// exercise the genuine `rg` binary; a non-existent dir simulates "not
// installed").
func newGrepTestSSHConnection(t *testing.T, pathOverride string) (svc *SSHFileService, homeDir string) {
	t.Helper()
	homeDir = t.TempDir()
	for _, dir := range []string{"src", ".git", filepath.Join("node_modules", "pkg")} {
		if err := os.MkdirAll(filepath.Join(homeDir, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"src/main.go":               "func main() {\n\treturn nil\n}\n// TODO: cleanup this function\n",
		"README.md":                 "# Project\nTODO: write docs\n",
		".git/config":               "TODO: ignored\n",
		"node_modules/pkg/index.js": "TODO: ignored\n",
	}
	for relPath, content := range files {
		full := filepath.Join(homeDir, filepath.FromSlash(relPath))
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	addr := startTestSSHFileServer(t, homeDir, pathOverride)
	pool := newTestSSHFilePool(t, addr)
	return NewSSHFileService(pool), homeDir
}

func TestSSHFileServiceGrepRequiresQuery(t *testing.T) {
	// Query validation happens before any pooled SSH access, so a nil pool
	// (which would hang/panic if Grep ever tried to dial it) is safe here —
	// mirrors TestWorktreeFileServiceGrepRequiresQuery.
	svc := NewSSHFileService(nil)
	if _, err := svc.Grep(context.Background(), "sc-test", "   ", GrepOptions{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty query error = %v, want ErrValidation", err)
	}
}

func TestSSHFileServiceGrepReportsRgUnavailable(t *testing.T) {
	// pathOverride points at an empty directory so `command -v rg` fails
	// deterministically, regardless of whether the machine running this test
	// suite actually has ripgrep installed.
	svc, _ := newGrepTestSSHConnection(t, t.TempDir())

	result, err := svc.Grep(context.Background(), "sc-test", "TODO", GrepOptions{})
	if err != nil {
		t.Fatalf("Grep with rg unavailable: %v", err)
	}
	if result.RgAvailable {
		t.Error("RgAvailable = true, want false")
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want empty", result.Files)
	}
}

func TestSSHFileServiceGrepFindsLiteralMatchesCaseInsensitiveByDefault(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, _ := newGrepTestSSHConnection(t, "")

	result, err := svc.Grep(context.Background(), "sc-test", "todo", GrepOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.RgAvailable {
		t.Fatal("RgAvailable = false, want true")
	}
	if result.Engine != "ripgrep" {
		t.Errorf("Engine = %q, want ripgrep", result.Engine)
	}
	got := map[string]int{}
	for _, f := range result.Files {
		got[f.Path] = len(f.Matches)
	}
	want := map[string]int{"src/main.go": 1, "README.md": 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Grep files = %v, want %v (node_modules/.git must be excluded)", got, want)
	}
	readme := result.Files[indexOfGrepFile(result.Files, "README.md")]
	if readme.Matches[0].Line != 2 {
		t.Errorf("README.md match line = %d, want 2", readme.Matches[0].Line)
	}
	if readme.Matches[0].Text != "TODO: write docs" {
		t.Errorf("README.md match text = %q, want %q", readme.Matches[0].Text, "TODO: write docs")
	}
}

func TestSSHFileServiceGrepCaseSensitive(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, _ := newGrepTestSSHConnection(t, "")

	result, err := svc.Grep(context.Background(), "sc-test", "todo", GrepOptions{CaseSensitive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 0 {
		t.Fatalf("case-sensitive lowercase query files = %v, want none (source text is uppercase TODO)", result.Files)
	}

	result, err = svc.Grep(context.Background(), "sc-test", "TODO", GrepOptions{CaseSensitive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 2 {
		t.Fatalf("case-sensitive uppercase query files = %v, want 2 files", result.Files)
	}
}

func TestSSHFileServiceGrepIncludePattern(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, _ := newGrepTestSSHConnection(t, "")

	result, err := svc.Grep(context.Background(), "sc-test", "TODO", GrepOptions{IncludePattern: "*.md"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].Path != "README.md" {
		t.Fatalf("includePattern *.md files = %v, want just README.md", result.Files)
	}
}

func TestSSHFileServiceGrepRegexModeAndInvalidRegex(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, _ := newGrepTestSSHConnection(t, "")

	literal, err := svc.Grep(context.Background(), "sc-test", "TODO:.*docs", GrepOptions{Regex: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(literal.Files) != 0 {
		t.Fatalf("literal mode treated %q as a regex: files = %v", "TODO:.*docs", literal.Files)
	}

	asRegex, err := svc.Grep(context.Background(), "sc-test", "TODO:.*docs", GrepOptions{Regex: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(asRegex.Files) != 1 || asRegex.Files[0].Path != "README.md" {
		t.Fatalf("regex mode files = %v, want just README.md", asRegex.Files)
	}

	if _, err := svc.Grep(context.Background(), "sc-test", "(unclosed", GrepOptions{Regex: true}); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid regex error = %v, want ErrValidation", err)
	}
}

// TestSSHFileServiceGrepQueryWithShellMetacharactersHasNoSideEffects is the
// single most important test in this file. query comes directly from an
// untrusted HTTP query param and is forwarded into a remote shell command —
// the highest-risk part of this whole feature. This proves a query string
// built to look like a shell-injection payload (embedded single quote,
// semicolon, an "rm -rf" attempting to delete a sentinel file, a "#" comment
// marker, and a second injected command) is delivered to the real remote
// shell as one literal, inert search string — never interpreted as shell
// syntax — by asserting the sentinel file survives untouched and the
// "attack"'s second command never ran.
//
// The rm -rf target is deliberately scoped to a file inside this test's own
// throwaway t.TempDir() (never "/" or any real path) — this command
// genuinely executes against the real local filesystem via the in-process
// fixture, so a real path is used only where a bug's worst case is losing a
// disposable temp file, never real data.
func TestSSHFileServiceGrepQueryWithShellMetacharactersHasNoSideEffects(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, homeDir := newGrepTestSSHConnection(t, "")

	sentinel := filepath.Join(homeDir, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("do not delete me"), 0o644); err != nil {
		t.Fatal(err)
	}
	pwnedMarker := filepath.Join(homeDir, "pwned.txt")

	dangerousQuery := "nope'; rm -rf " + sentinel + "; touch " + pwnedMarker + "; echo done #"

	result, err := svc.Grep(context.Background(), "sc-test", dangerousQuery, GrepOptions{})
	if err != nil {
		t.Fatalf("Grep with metacharacter-laden query: %v", err)
	}
	if !result.RgAvailable {
		t.Fatal("RgAvailable = false, want true")
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want no matches (the query is a literal string not present in any fixture file)", result.Files)
	}
	if data, statErr := os.ReadFile(sentinel); statErr != nil || string(data) != "do not delete me" {
		t.Fatalf("sentinel file = %q, %v, want unchanged %q — shell metacharacters were interpreted instead of treated literally", data, statErr, "do not delete me")
	}
	if _, statErr := os.Stat(pwnedMarker); statErr == nil {
		t.Fatal("pwned marker file was created — shell metacharacters were interpreted instead of treated literally")
	}
}

// symlinkOnlyPATH builds a throwaway directory containing nothing but a
// symlink to binName's real resolved path (via exec.LookPath), and is meant
// to be passed as startTestSSHFileServer's pathOverride so a remote exec
// session's PATH deterministically resolves that one binary and nothing
// else — used below to force the grep fallback by making `command -v rg`
// fail while `command -v grep` still finds the real system grep.
func symlinkOnlyPATH(t *testing.T, binName string) string {
	t.Helper()
	binPath, err := exec.LookPath(binName)
	if err != nil {
		t.Fatalf("exec.LookPath(%q): %v", binName, err)
	}
	dir := t.TempDir()
	if err := os.Symlink(binPath, filepath.Join(dir, binName)); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestSSHFileServiceGrepFallsBackToGrepWhenRgUnavailable proves the SSH-side
// grep fallback (executed remotely via sshmgr.CommandExists/RunCommand)
// produces the same GrepResult shape as the ripgrep path.
func TestSSHFileServiceGrepFallsBackToGrepWhenRgUnavailable(t *testing.T) {
	skipIfMissing(t, "grep")
	grepOnlyPath := symlinkOnlyPATH(t, "grep")
	svc, _ := newGrepTestSSHConnection(t, grepOnlyPath)

	result, err := svc.Grep(context.Background(), "sc-test", "todo", GrepOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.RgAvailable {
		t.Error("RgAvailable = true, want false (falling back to grep still means rg itself isn't installed)")
	}
	if result.Engine != "grep" {
		t.Errorf("Engine = %q, want grep", result.Engine)
	}
	got := map[string]int{}
	for _, f := range result.Files {
		got[f.Path] = len(f.Matches)
	}
	want := map[string]int{"src/main.go": 1, "README.md": 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("grep fallback files = %v, want %v (node_modules/.git must be excluded)", got, want)
	}
	readme := result.Files[indexOfGrepFile(result.Files, "README.md")]
	if readme.Matches[0].Line != 2 {
		t.Errorf("README.md match line = %d, want 2", readme.Matches[0].Line)
	}
	if readme.Matches[0].Text != "TODO: write docs" {
		t.Errorf("README.md match text = %q, want %q", readme.Matches[0].Text, "TODO: write docs")
	}
	if readme.Matches[0].Column != 0 {
		t.Errorf("README.md match column = %d, want 0 (grep doesn't report a match column)", readme.Matches[0].Column)
	}
}

// TestSSHFileServiceGrepFallbackQueryWithShellMetacharactersHasNoSideEffects
// is TestSSHFileServiceGrepQueryWithShellMetacharactersHasNoSideEffects's
// counterpart for the grep fallback path (forced via symlinkOnlyPATH so only
// grep, not rg, is resolvable on the remote PATH) — proving the same
// "malicious query survives as one literal search string, never
// shell-interpreted" guarantee holds when sshmgr.RunCommand executes `grep`
// instead of `rg`.
func TestSSHFileServiceGrepFallbackQueryWithShellMetacharactersHasNoSideEffects(t *testing.T) {
	skipIfMissing(t, "grep")
	grepOnlyPath := symlinkOnlyPATH(t, "grep")
	svc, homeDir := newGrepTestSSHConnection(t, grepOnlyPath)

	sentinel := filepath.Join(homeDir, "sentinel-grep.txt")
	if err := os.WriteFile(sentinel, []byte("do not delete me"), 0o644); err != nil {
		t.Fatal(err)
	}
	pwnedMarker := filepath.Join(homeDir, "pwned-grep.txt")

	dangerousQuery := "nope'; rm -rf " + sentinel + "; touch " + pwnedMarker + "; echo done #"

	result, err := svc.Grep(context.Background(), "sc-test", dangerousQuery, GrepOptions{})
	if err != nil {
		t.Fatalf("Grep with metacharacter-laden query via grep fallback: %v", err)
	}
	if result.Engine != "grep" {
		t.Fatalf("Engine = %q, want grep (test setup should have forced the grep fallback)", result.Engine)
	}
	if len(result.Files) != 0 {
		t.Errorf("Files = %v, want no matches (the query is a literal string not present in any fixture file)", result.Files)
	}
	if data, statErr := os.ReadFile(sentinel); statErr != nil || string(data) != "do not delete me" {
		t.Fatalf("sentinel file = %q, %v, want unchanged %q — shell metacharacters were interpreted instead of treated literally", data, statErr, "do not delete me")
	}
	if _, statErr := os.Stat(pwnedMarker); statErr == nil {
		t.Fatal("pwned marker file was created — shell metacharacters were interpreted instead of treated literally")
	}
}

// TestSSHFileServiceGrepIncludePatternWithShellMetacharactersHasNoSideEffects
// is the same attack shape as the query test above, aimed at
// opts.IncludePattern instead — the other untrusted query param this feature
// forwards into the remote command.
func TestSSHFileServiceGrepIncludePatternWithShellMetacharactersHasNoSideEffects(t *testing.T) {
	skipIfMissing(t, "rg")
	svc, homeDir := newGrepTestSSHConnection(t, "")

	sentinel := filepath.Join(homeDir, "sentinel2.txt")
	if err := os.WriteFile(sentinel, []byte("still here"), 0o644); err != nil {
		t.Fatal(err)
	}

	dangerousInclude := "*.go'; rm -rf " + sentinel + "; #"

	// rg may reject this as an invalid glob (surfaced as ErrValidation) or
	// simply match nothing — either is an acceptable literal-argument
	// outcome; what matters is that no side effect occurred.
	_, err := svc.Grep(context.Background(), "sc-test", "TODO", GrepOptions{IncludePattern: dangerousInclude})
	if err != nil && !errors.Is(err, ErrValidation) {
		t.Fatalf("unexpected error = %v", err)
	}
	if _, statErr := os.Stat(sentinel); statErr != nil {
		t.Fatalf("sentinel file was removed via includePattern injection: %v", statErr)
	}
}

// TestSSHFileServiceInstallRipgrepReturnsVersionOnSuccess stubs
// installRipgrepOverSSH (rather than exercising rginstall's real network
// path, already covered by internal/rginstall's own tests) to confirm
// SSHFileService.InstallRipgrep forwards its pool/connectionID and surfaces
// the returned version.
func TestSSHFileServiceInstallRipgrepReturnsVersionOnSuccess(t *testing.T) {
	origInstall := installRipgrepOverSSH
	var gotConnectionID string
	var gotPool *sshmgr.FilePool
	installRipgrepOverSSH = func(ctx context.Context, pool *sshmgr.FilePool, connectionID string) (string, error) {
		gotPool, gotConnectionID = pool, connectionID
		return "15.2.0", nil
	}
	defer func() { installRipgrepOverSSH = origInstall }()

	pool := newTestSSHFilePool(t, "127.0.0.1:1")
	svc := NewSSHFileService(pool)

	version, err := svc.InstallRipgrep(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("InstallRipgrep failed: %v", err)
	}
	if version != "15.2.0" {
		t.Errorf("version = %q, want 15.2.0", version)
	}
	if gotConnectionID != "sc-test" {
		t.Errorf("connectionID = %q, want sc-test", gotConnectionID)
	}
	if gotPool != pool {
		t.Error("installRipgrepOverSSH was not called with the service's own pool")
	}
}

func TestSSHFileServiceInstallRipgrepPropagatesInstallError(t *testing.T) {
	origInstall := installRipgrepOverSSH
	installRipgrepOverSSH = func(ctx context.Context, pool *sshmgr.FilePool, connectionID string) (string, error) {
		return "", fmt.Errorf("rginstall: unsupported remote OS %q", "SunOS")
	}
	defer func() { installRipgrepOverSSH = origInstall }()

	pool := newTestSSHFilePool(t, "127.0.0.1:1")
	svc := NewSSHFileService(pool)

	if _, err := svc.InstallRipgrep(context.Background(), "sc-test"); err == nil {
		t.Fatal("expected InstallRipgrep to propagate the install error, got nil")
	}
}

// TestSSHFileServiceSearchFindsFilesAndSkipsExcludedDirs proves Search's new
// `find`-over-exec implementation (replacing the old sftp.Client.Walk, one
// round trip per directory) still excludes node_modules/.git exactly like
// WorktreeFileService.Search and the SSH Grep tests above — same fixture,
// same expectation. An empty pattern matches every candidate (filePathMatcher's
// "raw == \"\"" branch), so this also proves the full, unfiltered listing
// itself is correct before any fuzzy-match narrowing is layered on.
func TestSSHFileServiceSearchFindsFilesAndSkipsExcludedDirs(t *testing.T) {
	skipIfMissing(t, "find")
	svc, _ := newGrepTestSSHConnection(t, "")

	results, err := svc.Search(context.Background(), "sc-test", "", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	want := map[string]bool{"src/main.go": true, "README.md": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Search results = %v, want %v (node_modules/.git must be excluded)", got, want)
	}
}

// TestSSHFileServiceSearchNarrowsByFuzzyPattern proves a non-empty pattern
// actually narrows the listing (not just that the unfiltered listing is
// correct) — searching "main" should surface src/main.go and nothing else.
func TestSSHFileServiceSearchNarrowsByFuzzyPattern(t *testing.T) {
	skipIfMissing(t, "find")
	svc, _ := newGrepTestSSHConnection(t, "")

	results, err := svc.Search(context.Background(), "sc-test", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0] != "src/main.go" {
		t.Fatalf("Search(%q) = %v, want just [src/main.go]", "main", results)
	}
}

// TestSSHFileServiceSearchIncludesDirectoriesWithTrailingSlash proves
// includeDirs surfaces directories (trailing-slash-suffixed, per
// FileQuickOpen's isDirectoryResult contract) alongside files, while pruned
// directories (node_modules, .git) still never appear as directory results
// either — find's `-prune` skips both descending into and printing a matched
// directory itself, matching the old walker's SkipDir behavior.
func TestSSHFileServiceSearchIncludesDirectoriesWithTrailingSlash(t *testing.T) {
	skipIfMissing(t, "find")
	svc, _ := newGrepTestSSHConnection(t, "")

	results, err := svc.Search(context.Background(), "sc-test", "", true)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	if !got["src/"] {
		t.Errorf("Search results = %v, want to include src/", results)
	}
	for _, excluded := range []string{".git/", "node_modules/", "node_modules/pkg/"} {
		if got[excluded] {
			t.Errorf("Search results = %v, must not include excluded dir %q", results, excluded)
		}
	}
}

// newDownloadTestSSHConnection serves a Download fixture over the same real
// in-process SFTP server the Grep/Search tests use: a UTF-8 text file, a
// binary file containing a NUL byte (the case Read refuses), and a directory.
// There is no symlink-escape case here — SSHFileService deliberately has no
// symlink hardening (see its doc comment: the remote sshd governs reach).
func newDownloadTestSSHConnection(t *testing.T) (svc *SSHFileService, homeDir string) {
	t.Helper()
	homeDir = t.TempDir()
	if err := os.MkdirAll(filepath.Join(homeDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(homeDir, "README.md"), []byte("read me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(homeDir, "docs", "logo.png"), binaryFixture, 0o644); err != nil {
		t.Fatal(err)
	}

	addr := startTestSSHFileServer(t, homeDir, "")
	pool := newTestSSHFilePool(t, addr)
	return NewSSHFileService(pool), homeDir
}

func TestSSHFileServiceDownloadReturnsExactBytes(t *testing.T) {
	svc, _ := newDownloadTestSSHConnection(t)

	var dst bytes.Buffer
	meta, err := svc.Download(context.Background(), "sc-test", "README.md", &dst)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "README.md" {
		t.Errorf("meta.Path = %q, want README.md", meta.Path)
	}
	if meta.Size != int64(len("read me\n")) {
		t.Errorf("meta.Size = %d, want %d", meta.Size, len("read me\n"))
	}
	if meta.ModTime.IsZero() {
		t.Error("meta.ModTime is zero, want the remote file's mtime")
	}
	if dst.String() != "read me\n" {
		t.Errorf("downloaded bytes = %q, want %q", dst.String(), "read me\n")
	}
}

// TestSSHFileServiceDownloadSucceedsForBinaryFile is the SSH counterpart of
// the worktree binary test: Read rejects this file as non-UTF-8, Download
// must stream its bytes unchanged.
func TestSSHFileServiceDownloadSucceedsForBinaryFile(t *testing.T) {
	svc, _ := newDownloadTestSSHConnection(t)

	if _, err := svc.Read(context.Background(), "sc-test", "docs/logo.png"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Read of a binary file error = %v, want ErrValidation (fixture must be one Read refuses)", err)
	}

	var dst bytes.Buffer
	meta, err := svc.Download(context.Background(), "sc-test", "docs/logo.png", &dst)
	if err != nil {
		t.Fatalf("Download of a binary file: %v", err)
	}
	if meta.Size != int64(len(binaryFixture)) {
		t.Errorf("meta.Size = %d, want %d", meta.Size, len(binaryFixture))
	}
	if !bytes.Equal(dst.Bytes(), binaryFixture) {
		t.Errorf("downloaded bytes = %#v, want %#v", dst.Bytes(), binaryFixture)
	}
}

func TestSSHFileServiceDownloadIgnoresTheEditorSizeLimit(t *testing.T) {
	svc, homeDir := newDownloadTestSSHConnection(t)
	big := bytes.Repeat([]byte("x"), maxEditableFileSize+1)
	if err := os.WriteFile(filepath.Join(homeDir, "big.log"), big, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Read(context.Background(), "sc-test", "big.log"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Read of an oversized file error = %v, want ErrValidation", err)
	}

	var dst bytes.Buffer
	meta, err := svc.Download(context.Background(), "sc-test", "big.log", &dst)
	if err != nil {
		t.Fatalf("Download of an oversized file: %v", err)
	}
	if meta.Size != int64(len(big)) || dst.Len() != len(big) {
		t.Errorf("meta.Size = %d, wrote %d bytes, want %d for both", meta.Size, dst.Len(), len(big))
	}
}

func TestSSHFileServiceDownloadRejectsDirectoryAndBadPaths(t *testing.T) {
	svc, _ := newDownloadTestSSHConnection(t)

	var dst bytes.Buffer
	if _, err := svc.Download(context.Background(), "sc-test", "docs", &dst); !errors.Is(err, ErrValidation) {
		t.Errorf("directory Download error = %v, want ErrValidation", err)
	}
	if _, err := svc.Download(context.Background(), "sc-test", "", &dst); !errors.Is(err, ErrValidation) {
		t.Errorf("empty-path Download error = %v, want ErrValidation", err)
	}
	if _, err := svc.Download(context.Background(), "sc-test", "../outside.txt", &dst); !errors.Is(err, ErrValidation) {
		t.Errorf("traversal Download error = %v, want ErrValidation", err)
	}
	if _, err := svc.Download(context.Background(), "sc-test", "/etc/passwd", &dst); !errors.Is(err, ErrValidation) {
		t.Errorf("absolute-path Download error = %v, want ErrValidation", err)
	}
	if _, err := svc.Download(context.Background(), "sc-test", "nope.txt", &dst); err == nil {
		t.Error("missing-file Download error = nil, want an error")
	}
	if dst.Len() != 0 {
		t.Errorf("rejected downloads wrote %d bytes, want 0", dst.Len())
	}
}

func TestSSHFileServiceMkdirMoveAndCopy(t *testing.T) {
	svc, homeDir := newDownloadTestSSHConnection(t)
	ctx := context.Background()

	dir, err := svc.Mkdir(ctx, "sc-test", "notes")
	if err != nil {
		t.Fatal(err)
	}
	if !dir.IsDir || dir.Path != "notes" {
		t.Fatalf("Mkdir entry = %+v, want IsDir notes", dir)
	}
	if info, statErr := os.Stat(filepath.Join(homeDir, "notes")); statErr != nil || !info.IsDir() {
		t.Fatalf("notes not created on disk: %v", statErr)
	}
	if _, err := svc.Mkdir(ctx, "sc-test", "notes"); !errors.Is(err, ErrConflict) {
		t.Fatalf("Mkdir over existing folder error = %v, want ErrConflict", err)
	}

	moved, err := svc.Move(ctx, "sc-test", "README.md", "notes/README.md")
	if err != nil {
		t.Fatal(err)
	}
	if moved.Path != "notes/README.md" {
		t.Fatalf("Move entry = %+v, want notes/README.md", moved)
	}
	if _, statErr := os.Stat(filepath.Join(homeDir, "README.md")); !os.IsNotExist(statErr) {
		t.Fatalf("README.md still exists after Move: %v", statErr)
	}
	if data, readErr := os.ReadFile(filepath.Join(homeDir, "notes", "README.md")); readErr != nil || string(data) != "read me\n" {
		t.Fatalf("moved file content = %q, %v, want %q", data, readErr, "read me\n")
	}

	if _, err := svc.Move(ctx, "sc-test", "notes", "notes/nested"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Move folder into itself error = %v, want ErrValidation", err)
	}
	if _, err := svc.Move(ctx, "sc-test", "docs/logo.png", "notes/README.md"); !errors.Is(err, ErrConflict) {
		t.Fatalf("Move onto existing file error = %v, want ErrConflict", err)
	}

	copied, err := svc.Copy(ctx, "sc-test", "notes/README.md", "notes/README-copy.md")
	if err != nil {
		t.Fatal(err)
	}
	if copied.Path != "notes/README-copy.md" {
		t.Fatalf("Copy entry = %+v, want notes/README-copy.md", copied)
	}
	if data, readErr := os.ReadFile(filepath.Join(homeDir, "notes", "README.md")); readErr != nil || string(data) != "read me\n" {
		t.Fatalf("Copy source mutated: %q, %v", data, readErr)
	}
	if data, readErr := os.ReadFile(filepath.Join(homeDir, "notes", "README-copy.md")); readErr != nil || string(data) != "read me\n" {
		t.Fatalf("Copy destination content = %q, %v, want %q", data, readErr, "read me\n")
	}

	dirCopy, err := svc.Copy(ctx, "sc-test", "notes", "notes-copy")
	if err != nil {
		t.Fatal(err)
	}
	if !dirCopy.IsDir {
		t.Fatalf("Copy of a folder entry = %+v, want IsDir", dirCopy)
	}
	for _, want := range []string{"README.md", "README-copy.md"} {
		if data, readErr := os.ReadFile(filepath.Join(homeDir, "notes-copy", want)); readErr != nil || string(data) != "read me\n" {
			t.Fatalf("notes-copy/%s = %q, %v, want %q", want, data, readErr, "read me\n")
		}
	}
}

// TestSSHFileServiceSearchReusesCollectedListing proves a second search does
// NOT re-walk the remote tree. Quick-open re-queries on every keystroke and
// the pattern is only ever applied in Go, so re-running `find` per keystroke
// re-derived an identical listing at the cost of seconds of remote I/O each
// — and, because nothing cancelled the abandoned ones, piled up SSH channels
// until sshd's MaxSessions cap started failing every later request.
//
// The out-of-band file is the assertion: it is created behind the service's
// back (so nothing invalidates the cache), and a search that re-walked would
// find it.
func TestSSHFileServiceSearchReusesCollectedListing(t *testing.T) {
	skipIfMissing(t, "find")
	svc, homeDir := newGrepTestSSHConnection(t, "")

	if _, err := svc.Search(context.Background(), "sc-test", "", false); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(homeDir, "appeared-later.go"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	results, err := svc.Search(context.Background(), "sc-test", "appeared", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("Search = %v, want no results: the cached listing was discarded and the remote tree re-walked", results)
	}
}

// TestSSHFileServiceSearchSeesPathsChangedThroughTheService is the other half
// of the caching contract: DevDeck's own writes invalidate the listing, so an
// operator never has to wait out sshListingTTL to quick-open a file they just
// created here.
func TestSSHFileServiceSearchSeesPathsChangedThroughTheService(t *testing.T) {
	skipIfMissing(t, "find")
	svc, _ := newGrepTestSSHConnection(t, "")
	ctx := context.Background()

	if _, err := svc.Search(ctx, "sc-test", "", false); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Write(ctx, "sc-test", "src/added.go", "package main\n"); err != nil {
		t.Fatal(err)
	}
	results, err := svc.Search(ctx, "sc-test", "added", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0] != "src/added.go" {
		t.Fatalf("Search after Write = %v, want [src/added.go]", results)
	}

	if err := svc.Delete(ctx, "sc-test", "src/added.go"); err != nil {
		t.Fatal(err)
	}
	results, err = svc.Search(ctx, "sc-test", "added", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("Search after Delete = %v, want no results", results)
	}
}

// TestSSHFileServiceSearchReportsCollectionFailure proves a remote listing
// that could not run surfaces as an error rather than an empty result set.
// Swallowing it (the old `stdout, _, _ :=`) made a genuinely broken remote
// search render in quick-open as the indistinguishable, and wrong, "No
// matching files or folders".
func TestSSHFileServiceSearchReportsCollectionFailure(t *testing.T) {
	// An empty PATH means the remote shell cannot resolve `find` at all.
	svc, _ := newGrepTestSSHConnection(t, t.TempDir())

	results, err := svc.Search(context.Background(), "sc-test", "", false)
	if err == nil {
		t.Fatalf("Search = %v, want an error when the remote listing command cannot run", results)
	}
}

// TestSSHFileServiceSearchMatchesSpaceSeparatedFolderAndFileTokens pins the
// multi-token behavior an operator actually reaches for on a remote host:
// typing a folder and a filename separated by a space ("core secret.yml")
// must find core/secret.yml *and* the same file nested arbitrarily deeper
// (core/depo/secret.yml), without the operator having to know or type the
// intermediate path segments.
//
// The matcher (filePathMatcher.tokens / tokenSequenceScore, shared with
// worktree search) has always supported this; it is pinned here because on
// SSH the capability was invisible for a different reason — the remote listing
// was being silently truncated, so the file the tokens would have matched was
// frequently not in the listing at all. This test proves the whole path works
// end to end over a real SSH connection, not just the scoring function.
func TestSSHFileServiceSearchMatchesSpaceSeparatedFolderAndFileTokens(t *testing.T) {
	skipIfMissing(t, "find")
	homeDir := t.TempDir()
	for _, relPath := range []string{
		"core/secret.yml",
		"core/depo/secret.yml",
		"core/depo/deep/secret.yml",
		"core/readme.md",
		"other/secret.yml",
	} {
		full := filepath.Join(homeDir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewSSHFileService(newTestSSHFilePool(t, startTestSSHFileServer(t, homeDir, "")))

	results, err := svc.Search(context.Background(), "sc-test", "core secret.yml", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	for _, want := range []string{"core/secret.yml", "core/depo/secret.yml", "core/depo/deep/secret.yml"} {
		if !got[want] {
			t.Errorf("Search(%q) = %v, want it to include %q", "core secret.yml", results, want)
		}
	}
	// Tokens must still be *discriminating*: a path missing the "core" token
	// entirely, or missing the filename, is not a match.
	for _, unwanted := range []string{"other/secret.yml", "core/readme.md"} {
		if got[unwanted] {
			t.Errorf("Search(%q) = %v, must not include %q", "core secret.yml", results, unwanted)
		}
	}
	// Shallower matches outrank deeper ones, so the most likely intent is
	// first in the list rather than buried under nested near-misses.
	if len(results) > 0 && results[0] != "core/secret.yml" {
		t.Errorf("Search(%q) ranked %q first, want the shallowest match core/secret.yml", "core secret.yml", results[0])
	}
}

// TestSSHFileServiceSearchTokenizesQueriesContainingRegexMetacharacters
// covers the case that made multi-token search look broken for whole classes
// of real project: a query carrying a regex metacharacter used to be compiled
// as a regex instead of tokenized, and then matched nothing at all. Next.js
// dynamic segments (app/[id]/page.tsx) are the everyday example — "app [id]
// page" returned zero results. Whitespace in the query now settles it in
// favor of token matching (see looksLikeRegex).
func TestSSHFileServiceSearchTokenizesQueriesContainingRegexMetacharacters(t *testing.T) {
	skipIfMissing(t, "find")
	homeDir := t.TempDir()
	for _, relPath := range []string{"app/[id]/page.tsx", "app/about/page.tsx"} {
		full := filepath.Join(homeDir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewSSHFileService(newTestSSHFilePool(t, startTestSSHFileServer(t, homeDir, "")))

	results, err := svc.Search(context.Background(), "sc-test", "app [id] page", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	if !got["app/[id]/page.tsx"] {
		t.Errorf("Search(%q) = %v, want app/[id]/page.tsx", "app [id] page", results)
	}
	if got["app/about/page.tsx"] {
		t.Errorf("Search(%q) = %v, must not include app/about/page.tsx (the [id] token is discriminating)", "app [id] page", results)
	}

	// A single-token query with metacharacters and no whitespace keeps its
	// regex meaning — this veto is scoped to multi-token queries only.
	regexResults, err := svc.Search(context.Background(), "sc-test", `page\.tsx$`, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(regexResults) != 2 {
		t.Errorf("Search(%q) = %v, want both page.tsx files via regex matching", `page\.tsx$`, regexResults)
	}
}

// TestSSHFileServiceSearchMatchesFolderTokensForDirectories is the folder half
// of the case above: the same space-separated token search must also surface
// *directories* when includeDirs is set, so "core depo" jumps straight to the
// folder rather than only to files inside it.
func TestSSHFileServiceSearchMatchesFolderTokensForDirectories(t *testing.T) {
	skipIfMissing(t, "find")
	homeDir := t.TempDir()
	for _, dir := range []string{"core/depo/deep", "other/depo"} {
		if err := os.MkdirAll(filepath.Join(homeDir, filepath.FromSlash(dir)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewSSHFileService(newTestSSHFilePool(t, startTestSSHFileServer(t, homeDir, "")))

	results, err := svc.Search(context.Background(), "sc-test", "core depo", true)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	if !got["core/depo/"] {
		t.Errorf("Search(%q, includeDirs) = %v, want the folder core/depo/", "core depo", results)
	}
	if got["other/depo/"] {
		t.Errorf("Search(%q, includeDirs) = %v, must not include other/depo/", "core depo", results)
	}
}

// TestSSHFileServiceSearchCollectsWholeListingInOneRemoteCommand guards the
// single-traversal property that makes remote search affordable. The previous
// implementation ran a `-type f` find and a `-type d` find concurrently — two
// complete walks of the identical tree to produce two halves of one listing.
// Collecting both from one walk is the difference this asserts: exactly one
// remote command per cold collection, and none at all once cached.
func TestSSHFileServiceSearchCollectsWholeListingInOneRemoteCommand(t *testing.T) {
	skipIfMissing(t, "find")
	svc, _ := newGrepTestSSHConnection(t, "")
	resetTestSSHExecCount()

	if _, err := svc.Search(context.Background(), "sc-test", "", true); err != nil {
		t.Fatal(err)
	}
	if got := testSSHExecCount.Load(); got != 1 {
		t.Fatalf("cold Search ran %d remote commands, want exactly 1 (files and dirs must share one traversal)", got)
	}

	// The cached listing serves both a files-only and a with-dirs search
	// without touching the remote host again.
	if _, err := svc.Search(context.Background(), "sc-test", "main", false); err != nil {
		t.Fatal(err)
	}
	if got := testSSHExecCount.Load(); got != 1 {
		t.Fatalf("warm Search ran %d remote commands total, want the cached listing to be reused", got)
	}
}

// TestSSHFileServiceSearchPrunesHomeDirectoryCaches proves the SSH listing
// prunes the toolchain/OS cache trees that dominate a real home directory.
// This is the fix for remote search being unusable rather than merely slow:
// rooted at $HOME with only the worktree-tuned prune set, the walk on a real
// developer machine did not finish inside sshSearchBudget at all, so quick-open
// returned whatever arbitrary prefix of the tree `find` had emitted before it
// was killed — almost never the file the operator was looking for.
func TestSSHFileServiceSearchPrunesHomeDirectoryCaches(t *testing.T) {
	skipIfMissing(t, "find")
	homeDir := t.TempDir()
	// One real project file, and one file inside each cache tree that must
	// never be walked. `go/pkg` stands in for the Go module cache, which is
	// pruned by the `pkg` name.
	fixture := map[string]string{
		"work/app.go":             "package main\n",
		".cache/huggingface/a.go": "cached\n",
		"Library/Caches/b.go":     "cached\n",
		".cargo/registry/c.go":    "cached\n",
		".nvm/versions/d.go":      "cached\n",
		"go/pkg/mod/e.go":         "cached\n",
		".venv/lib/f.go":          "cached\n",
		"__pycache__/g.go":        "cached\n",
	}
	for relPath, content := range fixture {
		full := filepath.Join(homeDir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewSSHFileService(newTestSSHFilePool(t, startTestSSHFileServer(t, homeDir, "")))

	results, err := svc.Search(context.Background(), "sc-test", "", true)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	if !got["work/app.go"] {
		t.Errorf("Search results = %v, want the real project file work/app.go", results)
	}
	for _, pruned := range []string{
		".cache/huggingface/a.go", "Library/Caches/b.go", ".cargo/registry/c.go",
		".nvm/versions/d.go", "go/pkg/mod/e.go", ".venv/lib/f.go", "__pycache__/g.go",
		".cache/", "Library/", ".cargo/", ".nvm/", "go/pkg/", ".venv/", "__pycache__/",
	} {
		if got[pruned] {
			t.Errorf("Search results = %v, must not include pruned cache path %q", results, pruned)
		}
	}
}

// TestSSHFileServiceSearchHandlesNewlineInPathNames proves the listing is
// parsed as NUL-delimited records rather than lines. With `-print`/newline
// splitting, a single path containing a newline silently became two bogus
// listing entries (neither of which is openable), corrupting every result
// after it in that batch.
func TestSSHFileServiceSearchHandlesNewlineInPathNames(t *testing.T) {
	skipIfMissing(t, "find")
	homeDir := t.TempDir()
	awkward := "we\nird.go"
	if err := os.WriteFile(filepath.Join(homeDir, awkward), []byte("package main\n"), 0o644); err != nil {
		t.Skipf("filesystem rejects newlines in file names: %v", err)
	}
	if err := os.WriteFile(filepath.Join(homeDir, "normal.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewSSHFileService(newTestSSHFilePool(t, startTestSSHFileServer(t, homeDir, "")))

	results, err := svc.Search(context.Background(), "sc-test", "", false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range results {
		got[r] = true
	}
	if !got[awkward] {
		t.Errorf("Search results = %q, want the newline-containing path intact as one entry", results)
	}
	for _, fragment := range []string{"we", "ird.go"} {
		if got[fragment] {
			t.Errorf("Search results = %q, must not contain split fragment %q", results, fragment)
		}
	}
	if !got["normal.go"] {
		t.Errorf("Search results = %q, want normal.go", results)
	}
}

// TestSSHFileServiceSearchFailsLoudlyWhenListingTimesOut is the regression
// test for the most user-visible half of "remote search doesn't work". The old
// code accepted a timed-out listing as long as `find` had printed *something*
// before being killed, so an operator on a large remote home directory got a
// silently truncated listing: they typed a filename they knew existed, the walk
// had been cut off long before reaching it, and quick-open reported a clean
// "no matching files" that was indistinguishable from the file not existing.
// A timeout must surface as an actionable error instead.
func TestSSHFileServiceSearchFailsLoudlyWhenListingTimesOut(t *testing.T) {
	// A stub `find` that emits one complete record and then hangs, so the
	// collection is guaranteed to time out holding partial-but-nonempty output
	// — precisely the case the old code accepted as success. The stub runs
	// under a PATH restricted to binDir, so every binary it and the pipeline
	// need (`sleep` to hang, `head` for the byte cap) must be linked in
	// explicitly rather than inherited.
	binDir := t.TempDir()
	stub := "#!/bin/sh\nprintf 'partial.go\\0'\nsleep 30\n"
	if err := os.WriteFile(filepath.Join(binDir, "find"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, bin := range []string{"head", "sleep"} {
		resolved, err := exec.LookPath(bin)
		if err != nil {
			t.Skipf("%s not available: %v", bin, err)
		}
		if err := os.Symlink(resolved, filepath.Join(binDir, bin)); err != nil {
			t.Fatal(err)
		}
	}

	restore := sshSearchBudget
	sshSearchBudget = 300 * time.Millisecond
	t.Cleanup(func() { sshSearchBudget = restore })

	svc, _ := newGrepTestSSHConnection(t, binDir)

	results, err := svc.Search(context.Background(), "sc-test", "", false)
	if err == nil {
		t.Fatalf("Search = %v, want a timeout error rather than a silently truncated listing", results)
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("Search error = %q, want it to name the timeout so the operator can act on it", err)
	}
}

// TestSSHFileServiceReadReturnsWholeFile guards the switch from io.ReadAll to
// io.Copy in Read. io.Copy takes sftp.File's WriteTo fast path (many read
// requests pipelined concurrently) instead of ReadAll's serial 512-byte-and-
// growing reads, which is what made opening a remote file in the editor cost
// dozens of round trips. The content here is deliberately larger than one
// SFTP packet so it exercises the multi-chunk path, not just a single read.
func TestSSHFileServiceReadReturnsWholeFile(t *testing.T) {
	svc, homeDir := newGrepTestSSHConnection(t, "")

	var sb strings.Builder
	for i := 0; i < 20000; i++ {
		fmt.Fprintf(&sb, "line %d — αβγ\n", i)
	}
	want := sb.String()
	if err := os.WriteFile(filepath.Join(homeDir, "big.txt"), []byte(want), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Read(context.Background(), "sc-test", "big.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != want {
		t.Fatalf("Read returned %d bytes, want %d (content mismatch)", len(got.Content), len(want))
	}
}

// newExtractTestSSHConnection builds an SSH connection fixture for the
// Extract tests: an existing "dest" folder to extract into (matching
// Upload's contract that the destination folder must already exist), served
// over the same in-process SSH server fixture the Grep/Search/Download tests
// above use. buildTestZip/assertDirEmpty are worktree_file_test.go's
// (same package, reused rather than redefined — identical fixture shape is
// what makes the two Extract test suites comparable).
func newExtractTestSSHConnection(t *testing.T) (svc *SSHFileService, homeDir string) {
	t.Helper()
	homeDir = t.TempDir()
	if err := os.MkdirAll(filepath.Join(homeDir, "dest"), 0o755); err != nil {
		t.Fatal(err)
	}
	addr := startTestSSHFileServer(t, homeDir, "")
	pool := newTestSSHFilePool(t, addr)
	return NewSSHFileService(pool), homeDir
}

func TestSSHFileServiceExtractHappyPathNestedDirectories(t *testing.T) {
	svc, homeDir := newExtractTestSSHConnection(t)
	archive := buildTestZip(t, map[string]string{
		"README.md":          "hello",
		"src/":               "",
		"src/nested/":        "",
		"src/nested/main.go": "package main",
	})

	entries, err := svc.Extract(context.Background(), "sc-test", "dest", bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("Extract returned no entries")
	}

	wantContents := map[string]string{
		"dest/README.md":          "hello",
		"dest/src/nested/main.go": "package main",
	}
	for relPath, want := range wantContents {
		data, err := os.ReadFile(filepath.Join(homeDir, filepath.FromSlash(relPath)))
		if err != nil {
			t.Fatalf("read %s: %v", relPath, err)
		}
		if string(data) != want {
			t.Errorf("%s content = %q, want %q", relPath, data, want)
		}
	}
	if info, err := os.Stat(filepath.Join(homeDir, "dest", "src", "nested")); err != nil || !info.IsDir() {
		t.Fatalf("dest/src/nested not created as a folder: %v", err)
	}
}

// TestSSHFileServiceExtractRejectsEscapingAndAbsolutePaths mirrors
// WorktreeFileServiceExtract's zip-slip coverage exactly: a leading ".."
// segment, an absolute path, and a path that only escapes after cleaning.
func TestSSHFileServiceExtractRejectsEscapingAndAbsolutePaths(t *testing.T) {
	tests := []struct {
		name  string
		entry string
	}{
		{"parent traversal", "../x"},
		{"absolute path", "/abs/x"},
		{"nested traversal", "a/../../x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, homeDir := newExtractTestSSHConnection(t)
			archive := buildTestZip(t, map[string]string{tt.entry: "malicious"})

			if _, err := svc.Extract(context.Background(), "sc-test", "dest", bytes.NewReader(archive)); !errors.Is(err, ErrValidation) {
				t.Fatalf("Extract(%q) error = %v, want ErrValidation", tt.entry, err)
			}
			assertDirEmpty(t, filepath.Join(homeDir, "dest"))
		})
	}
}

// TestSSHFileServiceExtractRejectsSymlinkEntry mirrors
// WorktreeFileServiceExtractRejectsSymlinkEntry: a symlink entry is rejected
// rather than followed.
func TestSSHFileServiceExtractRejectsSymlinkEntry(t *testing.T) {
	svc, homeDir := newExtractTestSSHConnection(t)

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

	_, extractErr := svc.Extract(context.Background(), "sc-test", "dest", bytes.NewReader(buf.Bytes()))
	if !errors.Is(extractErr, ErrValidation) {
		t.Fatalf("symlink entry error = %v, want ErrValidation", extractErr)
	}
	if !strings.Contains(extractErr.Error(), "is a symlink") {
		t.Fatalf("symlink error message = %q, want it to name the symlink", extractErr)
	}
	assertDirEmpty(t, filepath.Join(homeDir, "dest"))
}

// TestSSHFileServiceExtractInvalidatesCacheOnPartialFailure proves a
// mid-write failure still drops the cached listing. A partial extraction
// (one entry written, the next colliding with an existing directory) returns
// an error with files already on the host; if the cache survived, Search
// would keep serving the pre-extract set for up to sshListingTTL and hide
// what actually landed. This pins Extract's unconditional invalidation.
func TestSSHFileServiceExtractInvalidatesCacheOnPartialFailure(t *testing.T) {
	skipIfMissing(t, "find")
	svc, homeDir := newExtractTestSSHConnection(t)
	ctx := context.Background()

	// Seed the listing cache the way an operator's earlier quick-open would.
	if _, err := svc.Search(ctx, "sc-test", "", false); err != nil {
		t.Fatal(err)
	}

	// Extract to the home root. a.txt writes cleanly; the next entry, "dest",
	// collides with the fixture's existing "dest" directory, so the SFTP
	// Create fails and the whole Extract returns an error after a.txt landed.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if w, err := zw.Create("a.txt"); err != nil {
		t.Fatal(err)
	} else if _, err := w.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if w, err := zw.Create("dest"); err != nil {
		t.Fatal(err)
	} else if _, err := w.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Extract(ctx, "sc-test", "", bytes.NewReader(buf.Bytes())); err == nil {
		t.Fatal("expected a mid-write Extract to fail")
	}
	// a.txt really landed on the host.
	if _, err := os.Stat(filepath.Join(homeDir, "a.txt")); err != nil {
		t.Fatalf("a.txt was not written despite the partial failure: %v", err)
	}

	results, err := svc.Search(ctx, "sc-test", "a.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0] != "a.txt" {
		t.Fatalf("Search after partial Extract = %v, want [a.txt]: the cache was not invalidated on failure", results)
	}
}

// TestSSHFileServiceExtractRejectsTooManyEntries mirrors
// WorktreeFileServiceExtractRejectsTooManyEntries: the entry-count budget
// rejects the archive before writing a single remote file.
func TestSSHFileServiceExtractRejectsTooManyEntries(t *testing.T) {
	svc, homeDir := newExtractTestSSHConnection(t)

	files := make(map[string]string, maxExtractEntries+1)
	for i := 0; i < maxExtractEntries+1; i++ {
		files[fmt.Sprintf("f%05d.txt", i)] = ""
	}
	archive := buildTestZip(t, files)

	if _, err := svc.Extract(context.Background(), "sc-test", "dest", bytes.NewReader(archive)); !errors.Is(err, ErrValidation) {
		t.Fatalf("over-cap entry count error = %v, want ErrValidation", err)
	}
	assertDirEmpty(t, filepath.Join(homeDir, "dest"))
}

// TestSSHFileServiceExtractRejectsOversizeUncompressedTotal mirrors
// WorktreeFileServiceExtractRejectsOversizeUncompressedTotal: the
// uncompressed-size budget is enforced from the zip's declared metadata
// before any entry is decompressed/written, via the same
// zip.Writer.CreateRaw "declare a huge size, write one real byte" trick.
func TestSSHFileServiceExtractRejectsOversizeUncompressedTotal(t *testing.T) {
	svc, homeDir := newExtractTestSSHConnection(t)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	raw := []byte("x")
	header := &zip.FileHeader{
		Name:               "big.bin",
		Method:             zip.Store,
		UncompressedSize64: maxExtractUncompressedBytes + 1,
		CompressedSize64:   uint64(len(raw)),
	}
	w, err := zw.CreateRaw(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Extract(context.Background(), "sc-test", "dest", bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrValidation) {
		t.Fatalf("over-cap uncompressed size error = %v, want ErrValidation", err)
	}
	assertDirEmpty(t, filepath.Join(homeDir, "dest"))
}

// startKillableTestSSHFileServer is startTestSSHFileServer plus a handle on
// the accepted connections, so a test can drop them the way a flaky link
// does — the socket dies while the listener stays up, exactly the state
// behind "my SSH dropped and the folders never came back, but my shell
// still works" (the shell holds a different connection entirely).
func startKillableTestSSHFileServer(t *testing.T, homeDir string) (addr string, killConns func()) {
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

	var mu sync.Mutex
	var live []net.Conn
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			live = append(live, nc)
			mu.Unlock()
			go serveTestSSHFileConn(nc, cfg, homeDir, "")
		}
	}()

	return ln.Addr().String(), func() {
		mu.Lock()
		defer mu.Unlock()
		for _, nc := range live {
			_ = nc.Close()
		}
		live = nil
	}
}

// The file browser has to survive its own connection dying, because nothing
// else in the app notices that it did: the terminal holds a separate SSH
// connection and keeps working, so the operator sees a healthy shell beside a
// file tree that has collapsed to an error and will not come back no matter
// how often they press Retry.
//
// sshmgr.WithSFTPClient already had the recovery — evict the dead client,
// redial, run the operation again — but it is gated on errors.Is over what
// the operation returned, and every SFTP operation's error goes through
// fileOperationError on the way out. While that flattened its cause, the
// recovery was unreachable code and the pool handed the same dead client to
// every retry forever.
func TestSSHFileServiceListRecoversFromADeadPooledConnection(t *testing.T) {
	homeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(homeDir, "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	addr, killConns := startKillableTestSSHFileServer(t, homeDir)
	svc := NewSSHFileService(newTestSSHFilePool(t, addr))

	first, err := svc.List(context.Background(), "sc-test", "")
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(first) != 1 || first[0].Name != "notes.txt" {
		t.Fatalf("first list = %+v, want the one fixture file", first)
	}

	// The link drops. The pool does not know: nothing evicted the entry, so
	// the next call is handed the same, now-dead, *sftp.Client.
	killConns()

	second, err := svc.List(context.Background(), "sc-test", "")
	if err != nil {
		t.Fatalf("list after the connection died: %v — the pool never redialed, so Retry can only fail again", err)
	}
	if len(second) != 1 || second[0].Name != "notes.txt" {
		t.Fatalf("list after redial = %+v, want the one fixture file", second)
	}
}
