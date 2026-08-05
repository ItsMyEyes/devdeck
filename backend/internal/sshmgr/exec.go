package sshmgr

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

// WithSSHClient runs fn against connectionID's pooled *ssh.Client — the
// same cached transport WithSFTPClient's *sftp.Client rides on (see
// FilePool.GetSSH) — evicting and retrying exactly once if fn's error looks
// like a dead connection (isConnectionError) rather than an ordinary
// command failure (nonzero exit, ...), which is returned to the caller
// as-is. Mirrors WithSFTPClient's pooling/evict-retry-once contract
// exactly, just for the non-interactive exec use case instead of SFTP.
func WithSSHClient[T any](ctx context.Context, pool *FilePool, connectionID string, fn func(*ssh.Client) (T, error)) (T, error) {
	var zero T
	client, err := pool.GetSSH(ctx, connectionID)
	if err != nil {
		return zero, err
	}
	result, err := fn(client)
	if err == nil || !isConnectionError(err) {
		return result, err
	}
	pool.Evict(connectionID)
	client, err = pool.GetSSH(ctx, connectionID)
	if err != nil {
		return zero, err
	}
	return fn(client)
}

// shellQuote wraps s so it survives as one literal POSIX shell word: single
// quotes around the whole value, with any embedded single quote replaced by
// the standard close-escape-reopen trick (end the quoted string, emit a
// backslash-escaped literal quote, then start a new quoted string — see the
// ReplaceAll call below for the exact four-character replacement). SSH's
// exec model takes exactly one command string, interpreted by the remote
// shell — there is no argv-array exec over SSH — so this is the only way to
// hand the remote a value that can't be reinterpreted as shell syntax
// (metacharacters, substitution, redirection, etc.) no matter what it
// contains.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shellJoin quotes each of args via shellQuote and joins them into one
// shell-safe command string, preserving argument order.
func shellJoin(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}

// RunCommand runs args as one remote command over connectionID's pooled SSH
// connection, joining them into a shell-safe string via shellJoin so every
// element is treated as a literal argument — never shell-interpreted, no
// matter what characters it contains. stdout and stderr are captured
// separately (not combined) so callers can distinguish, e.g., "command
// produced no output" from "command wrote something to stderr" — needed by
// CommandExists to tell "found" from "not found". A nonzero remote exit
// status is returned as a non-nil error (typically *ssh.ExitError), along
// with whatever stdout/stderr was captured before the process exited.
//
// ctx bounds the *remote command*, not just the dial: Start/Wait is used
// instead of Run so a canceled or timed-out caller closes the SSH channel
// immediately (which hangs up the remote command's stdio) and gets
// ctx.Err() back, rather than blocking until the command finishes on its
// own. That matters because every RunCommand holds one channel on the
// shared pooled connection, and sshd caps those (OpenSSH's MaxSessions
// defaults to 10) — without cancellation, abandoned requests pile up
// channels until NewSession itself starts failing, taking the SFTP half of
// the same connection down with it. Whatever the command managed to print
// before the cancellation is still returned alongside ctx.Err().
func RunCommand(ctx context.Context, pool *FilePool, connectionID string, args []string) ([]byte, []byte, error) {
	return runRemote(ctx, pool, connectionID, shellJoin(args))
}

// RunPipeline runs stages as a single remote shell pipeline — stage[0] |
// stage[1] | ... — with every stage's argv quoted through the same shellJoin
// RunCommand uses, so the only shell syntax in the resulting command is the
// pipe characters this function itself inserts. No element of any stage can
// be reinterpreted as shell syntax, whatever it contains.
//
// This exists so a listing command can be bounded *on the remote side*
// (`find ... | head -c N`): when the downstream stage hits its limit and
// exits, the upstream stage takes SIGPIPE and stops walking, so a pathological
// remote tree costs a bounded amount of remote I/O and a bounded number of
// bytes on the wire — rather than being streamed in full only to be
// truncated once it has already been paid for.
//
// Note that a pipeline's exit status is the *last* stage's, so an upstream
// stage's nonzero exit (find hitting an unreadable directory, or dying of
// SIGPIPE) is masked. That is the desired behavior for the listing use case,
// which already treats a partial-but-nonempty find result as success.
func RunPipeline(ctx context.Context, pool *FilePool, connectionID string, stages [][]string) ([]byte, []byte, error) {
	joined := make([]string, len(stages))
	for i, stage := range stages {
		joined[i] = shellJoin(stage)
	}
	return runRemote(ctx, pool, connectionID, strings.Join(joined, " | "))
}

// runRemote executes one already-assembled remote command string, applying
// the pooling/eviction and context-cancellation contract documented on
// RunCommand above. Callers never build this string themselves — it always
// comes from shellJoin (RunCommand) or shellJoin-per-stage (RunPipeline).
func runRemote(ctx context.Context, pool *FilePool, connectionID string, cmd string) ([]byte, []byte, error) {
	type output struct {
		stdout []byte
		stderr []byte
	}
	out, err := WithSSHClient(ctx, pool, connectionID, func(client *ssh.Client) (output, error) {
		sess, err := client.NewSession()
		if err != nil {
			return output{}, fmt.Errorf("open session: %w", err)
		}
		defer sess.Close()

		var stdout, stderr bytes.Buffer
		sess.Stdout = &stdout
		sess.Stderr = &stderr

		if err := sess.Start(cmd); err != nil {
			return output{}, fmt.Errorf("start command: %w", err)
		}

		done := make(chan error, 1)
		go func() { done <- sess.Wait() }()

		select {
		case runErr := <-done:
			// Wait has returned, so its stdout/stderr copiers are finished
			// and both buffers are safe to read without racing them.
			return output{stdout: stdout.Bytes(), stderr: stderr.Bytes()}, runErr
		case <-ctx.Done():
			_ = sess.Close()
			<-done
			return output{stdout: stdout.Bytes(), stderr: stderr.Bytes()}, ctx.Err()
		}
	})
	return out.stdout, out.stderr, err
}

// CommandExists reports whether name is on connectionID's remote PATH,
// probed via the POSIX-portable `command -v name` (prints the resolved
// path and exits 0 when found; exits non-zero with no output when not).
// Only a dead-connection error is surfaced to the caller — an ordinary
// "not found" result (nonzero exit) is reported as (false, nil), matching
// what callers actually want to branch on (is rg usable, yes or no).
func CommandExists(ctx context.Context, pool *FilePool, connectionID string, name string) (bool, error) {
	stdout, _, err := RunCommand(ctx, pool, connectionID, []string{"command", "-v", name})
	if err != nil {
		if isConnectionError(err) {
			return false, err
		}
		return false, nil
	}
	return len(bytes.TrimSpace(stdout)) > 0, nil
}
