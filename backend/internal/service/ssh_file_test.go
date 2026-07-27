package service

import (
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
	"testing"

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

// runTestSSHFileExec runs command through the local shell, wires its real
// stdout/stderr to the channel, and sends a real exit-status back — this is
// what makes the shell-metacharacter-safety tests below meaningful: a
// genuine shell parses the delivered command string, not a stand-in. When
// pathOverride is non-empty, PATH is replaced entirely so `command -v rg`
// deterministically fails regardless of what's actually installed on the
// host running these tests.
func runTestSSHFileExec(ch ssh.Channel, command, pathOverride string) {
	defer ch.Close()
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
