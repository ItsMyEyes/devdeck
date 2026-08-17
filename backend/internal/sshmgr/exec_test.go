package sshmgr

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

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

// TestRunPipelineConnectsStagesAndQuotesEachOne proves RunPipeline's two
// guarantees at once: the stages really are joined into a working shell
// pipeline (stage 2 sees stage 1's stdout), and the only shell syntax in the
// delivered command is the pipe RunPipeline itself inserts — an argument
// containing pipes, semicolons and substitutions is still passed through
// literally, exactly as RunCommand promises.
func TestRunPipelineConnectsStagesAndQuotesEachOne(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	dangerousArg := "a|b; $(whoami) `oops` && rm -rf /nonexistent\n"

	stdout, stderr, err := RunPipeline(context.Background(), pool, "sc-test", [][]string{
		{"printf", "%s", dangerousArg},
		{"cat"},
	})
	if err != nil {
		t.Fatalf("RunPipeline: %v (stderr=%q)", err, stderr)
	}
	if string(stdout) != dangerousArg {
		t.Errorf("stdout = %q, want %q (metacharacters were shell-interpreted, or the pipeline did not connect)", stdout, dangerousArg)
	}
}

// TestRunPipelineStopsUpstreamStageAtDownstreamLimit proves the property the
// remote file listing depends on: when a downstream stage exits at its limit,
// the upstream stage is stopped by SIGPIPE rather than being allowed to run to
// completion. That is what bounds a listing's cost on the remote host itself
// instead of merely truncating output the host has already paid to produce.
func TestRunPipelineStopsUpstreamStageAtDownstreamLimit(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	// An unbounded producer: without SIGPIPE termination this never returns.
	producer := []string{"sh", "-c", "while :; do printf 'xxxxxxxxxx'; done"}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stdout, _, err := RunPipeline(ctx, pool, "sc-test", [][]string{producer, {"head", "-c", "64"}})
	if err != nil {
		t.Fatalf("RunPipeline: %v", err)
	}
	if len(stdout) != 64 {
		t.Errorf("stdout length = %d, want 64 (downstream limit must bound the pipeline)", len(stdout))
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Error("pipeline ran to the context deadline, so the unbounded upstream stage was never stopped")
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

// TestRunCommandStopsWaitingWhenContextIsCanceled proves RunCommand bounds
// the *remote command*, not merely the dial. Before Start/Wait replaced Run,
// a canceled or timed-out caller stayed blocked until the remote command
// finished on its own, so abandoned requests kept holding SSH channels on
// the shared pooled connection — and sshd caps those (OpenSSH's MaxSessions
// defaults to 10), which is how a burst of quick-open searches could wedge
// every later request, SFTP included.
func TestRunCommandStopsWaitingWhenContextIsCanceled(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, _, err := RunCommand(ctx, pool, "sc-test", []string{"sleep", "10"})
	elapsed := time.Since(start)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("RunCommand error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("RunCommand blocked %s — it waited out the remote command instead of the context", elapsed)
	}
}

// TestRunCommandStillReturnsOutputAfterCancellation proves cancellation
// doesn't throw away what the command already printed, so a partial listing
// stays usable to the caller that asked for it.
func TestRunCommandStillReturnsOutputAfterCancellation(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	stdout, _, err := RunCommand(ctx, pool, "sc-test", []string{"sh", "-c", "printf early; sleep 10"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("RunCommand error = %v, want context.DeadlineExceeded", err)
	}
	if string(stdout) != "early" {
		t.Errorf("stdout = %q, want %q — output printed before cancellation was dropped", stdout, "early")
	}
}

// TestFilePoolHomeCachesPerLiveConnection proves Home resolves the remote
// working directory once and then serves it from the pool entry, instead of
// spending an SFTP REALPATH round trip on every single file operation. The
// sentinel write is the assertion: a second call that re-resolved would
// return the real cwd, not the sentinel.
func TestFilePoolHomeCachesPerLiveConnection(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)
	ctx := context.Background()

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home, err := pool.Home(ctx, "sc-test")
	if err != nil {
		t.Fatalf("Home: %v", err)
	}
	if home != cwd {
		t.Fatalf("Home = %q, want the SFTP session's working directory %q", home, cwd)
	}

	pool.mu.Lock()
	pool.entries["sc-test"].home = "/sentinel"
	pool.mu.Unlock()

	again, err := pool.Home(ctx, "sc-test")
	if err != nil {
		t.Fatalf("Home (second call): %v", err)
	}
	if again != "/sentinel" {
		t.Errorf("Home (second call) = %q, want the cached %q — it re-resolved instead of reusing the entry", again, "/sentinel")
	}
}

// TestFilePoolHomeReresolvesAfterEvict proves the cache is tied to the live
// connection rather than the connection id, so a redial (possibly after the
// saved connection was edited to a different user or host) never inherits
// the previous connection's home directory.
func TestFilePoolHomeReresolvesAfterEvict(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)
	ctx := context.Background()

	if _, err := pool.Home(ctx, "sc-test"); err != nil {
		t.Fatalf("Home: %v", err)
	}
	pool.mu.Lock()
	pool.entries["sc-test"].home = "/sentinel"
	pool.mu.Unlock()

	pool.Evict("sc-test")

	home, err := pool.Home(ctx, "sc-test")
	if err != nil {
		t.Fatalf("Home after evict: %v", err)
	}
	if home == "/sentinel" {
		t.Error("Home returned the evicted connection's cached value instead of re-resolving")
	}
}

// TestRunShellCapturesExitCodeWithoutError proves RunShell's key departure
// from RunCommand: a nonzero remote exit is data, not a Go error, so a
// caller (an agent classifying/gating commands upstream) can inspect the
// exit code without also having to unwrap an error.
func TestRunShellCapturesExitCodeWithoutError(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	_, _, code, err := RunShell(context.Background(), pool, "sc-test", "exit 3")
	if err != nil {
		t.Fatalf("RunShell returned a transport error for a non-zero exit: %v", err)
	}
	if code != 3 {
		t.Fatalf("exitCode = %d, want 3", code)
	}
}

// TestRunShellPassesPipelinesThrough proves RunShell hands the command
// string to the remote shell verbatim: unlike RunCommand/RunPipeline, a
// pipe in the command is interpreted by the remote shell instead of being
// quoted away.
func TestRunShellPassesPipelinesThrough(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pool := newTestPool(t, addr)

	stdout, _, code, err := RunShell(context.Background(), pool, "sc-test", "echo hello | tr a-z A-Z")
	if err != nil || code != 0 {
		t.Fatalf("RunShell: err=%v code=%d", err, code)
	}
	if got := strings.TrimSpace(string(stdout)); got != "HELLO" {
		t.Fatalf("stdout = %q, want %q", got, "HELLO")
	}
}
