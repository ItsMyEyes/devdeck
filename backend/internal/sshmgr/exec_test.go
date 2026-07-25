package sshmgr

import (
	"context"
	"testing"

	"golang.org/x/crypto/ssh"
)

func newTestPool(t *testing.T, addr string) *FilePool {
	t.Helper()
	st := &fakeConnStore{conn: testConn(t, addr)}
	pool := NewFilePool(NewDialer(st, fakeSecrets{"password": "secret"}))
	t.Cleanup(func() {
		pool.mu.Lock()
		entries := pool.entries
		pool.entries = nil
		pool.mu.Unlock()
		for _, e := range entries {
			e.close()
		}
	})
	return pool
}

func TestShellQuoteEscapesEmbeddedSingleQuotes(t *testing.T) {
	got := shellQuote(`it's a test`)
	want := `'it'\''s a test'`
	if got != want {
		t.Errorf("shellQuote(%q) = %q, want %q", `it's a test`, got, want)
	}
}

func TestShellQuoteLeavesPlainArgsRecognizable(t *testing.T) {
	got := shellQuote("--json")
	want := "'--json'"
	if got != want {
		t.Errorf("shellQuote(%q) = %q, want %q", "--json", got, want)
	}
}

// TestRunCommandEscapesShellMetacharactersLiterally is the most important
// test in this file: it proves an argument containing shell metacharacters
// (single quotes, backticks, semicolons, $(...) substitution, &&, |) is
// delivered to the remote command as one literal argv-style word — never
// interpreted by the remote shell — by round-tripping it through `printf
// %s` and asserting the captured stdout is byte-for-byte identical to the
// original Go string.
func TestRunCommandEscapesShellMetacharactersLiterally(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	dangerousArg := "it's got a backtick `oops`; a semicolon; $(whoami) substitution; \"double quotes\"; && rm -rf /nonexistent | cat"

	stdout, stderr, err := RunCommand(context.Background(), pool, "sc-test", []string{"printf", "%s", dangerousArg})
	if err != nil {
		t.Fatalf("RunCommand: %v (stderr=%q)", err, stderr)
	}
	if len(stderr) != 0 {
		t.Errorf("stderr = %q, want empty", stderr)
	}
	if string(stdout) != dangerousArg {
		t.Errorf("stdout = %q, want %q (metacharacters were shell-interpreted instead of passed literally)", stdout, dangerousArg)
	}
}

func TestRunCommandCapturesStdoutAndStderrSeparately(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	stdout, stderr, err := RunCommand(context.Background(), pool, "sc-test",
		[]string{"sh", "-c", "printf out-content; printf err-content >&2"})
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if string(stdout) != "out-content" {
		t.Errorf("stdout = %q, want %q", stdout, "out-content")
	}
	if string(stderr) != "err-content" {
		t.Errorf("stderr = %q, want %q", stderr, "err-content")
	}
}

func TestRunCommandReturnsErrorForNonZeroExit(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	stdout, stderr, err := RunCommand(context.Background(), pool, "sc-test",
		[]string{"sh", "-c", "printf err-msg >&2; exit 3"})
	if err == nil {
		t.Fatal("RunCommand with nonzero remote exit succeeded, want error")
	}
	if len(stdout) != 0 {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if string(stderr) != "err-msg" {
		t.Errorf("stderr = %q, want %q", stderr, "err-msg")
	}
}

func TestCommandExistsTrueForExistingBinary(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	ok, err := CommandExists(context.Background(), pool, "sc-test", "sh")
	if err != nil {
		t.Fatalf("CommandExists: %v", err)
	}
	if !ok {
		t.Error("CommandExists(sh) = false, want true")
	}
}

func TestCommandExistsFalseForMissingBinary(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	ok, err := CommandExists(context.Background(), pool, "sc-test", "totally-not-a-real-binary-xyzzy12345")
	if err != nil {
		t.Fatalf("CommandExists: %v", err)
	}
	if ok {
		t.Error("CommandExists(missing binary) = true, want false")
	}
}

func TestWithSSHClientReusesPooledConnection(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)
	ctx := context.Background()

	var first, second *ssh.Client
	if _, err := WithSSHClient(ctx, pool, "sc-test", func(c *ssh.Client) (struct{}, error) {
		first = c
		return struct{}{}, nil
	}); err != nil {
		t.Fatalf("first WithSSHClient: %v", err)
	}
	if _, err := WithSSHClient(ctx, pool, "sc-test", func(c *ssh.Client) (struct{}, error) {
		second = c
		return struct{}{}, nil
	}); err != nil {
		t.Fatalf("second WithSSHClient: %v", err)
	}
	if first != second {
		t.Error("WithSSHClient dialed a new *ssh.Client instead of reusing the pooled one")
	}

	pool.mu.Lock()
	n := len(pool.entries)
	pool.mu.Unlock()
	if n != 1 {
		t.Errorf("pool.entries has %d entries, want 1 (SSH exec and SFTP should share one pooled connection)", n)
	}
}

func TestGetSSHSharesConnectionWithSFTPPool(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)
	ctx := context.Background()

	if _, err := pool.Get(ctx, "sc-test"); err != nil {
		t.Fatalf("Get: %v", err)
	}
	sshClient, err := pool.GetSSH(ctx, "sc-test")
	if err != nil {
		t.Fatalf("GetSSH: %v", err)
	}

	pool.mu.Lock()
	entry := pool.entries["sc-test"]
	pool.mu.Unlock()
	if entry == nil || entry.ssh != sshClient {
		t.Error("GetSSH did not return the same pooled *ssh.Client backing the SFTP pool's entry")
	}
}

func TestRunCommandEvictsAndRetriesDeadConnection(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)
	ctx := context.Background()

	if _, err := pool.GetSSH(ctx, "sc-test"); err != nil {
		t.Fatalf("warm pool: %v", err)
	}
	pool.mu.Lock()
	entry := pool.entries["sc-test"]
	pool.mu.Unlock()
	_ = entry.ssh.Close() // simulate a dead transport without evicting the cache entry

	stdout, _, err := RunCommand(ctx, pool, "sc-test", []string{"printf", "%s", "still-alive"})
	if err != nil {
		t.Fatalf("RunCommand after dead connection: %v", err)
	}
	if string(stdout) != "still-alive" {
		t.Errorf("stdout = %q, want %q", stdout, "still-alive")
	}

	pool.mu.Lock()
	newEntry := pool.entries["sc-test"]
	pool.mu.Unlock()
	if newEntry == entry {
		t.Error("dead connection was not evicted and redialed")
	}
}
