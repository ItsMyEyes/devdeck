package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/sshtool"
)

// ShellRunner executes a verbatim shell command over a saved SSH
// connection's pooled connection. Implemented in production by an adapter
// around sshmgr.RunShell; faked in tests with no real SSH server involved.
type ShellRunner interface {
	RunShell(ctx context.Context, connectionID, command string) (stdout, stderr []byte, exitCode int, err error)
}

// RemoteFiles is the subset of a saved SSH connection's remote file access
// the tool service needs. Its method set matches *SSHFileService's
// List/Read/Write/Grep exactly, so *SSHFileService satisfies it with no
// adapter — this interface exists purely so ssh_tool.go can be tested
// without a real SSH server or SFTP client anywhere in sight.
type RemoteFiles interface {
	List(ctx context.Context, connectionID, path string) ([]SSHFileEntry, error)
	Read(ctx context.Context, connectionID, path string) (SSHFileContent, error)
	Write(ctx context.Context, connectionID, path, content string) (SSHFileContent, error)
	Grep(ctx context.Context, connectionID, query string, opts GrepOptions) (GrepResult, error)
}

// ThreadPolicy reads the thread's current RuntimeMode from engine state.
type ThreadPolicy interface {
	ModeFor(threadID string) (provider.RuntimeMode, bool)
}

// ApprovalPrompter opens an approval card on the thread and blocks until the
// user answers, the thread is cancelled, or ctx ends.
type ApprovalPrompter interface {
	// `mutating` carries this service's own classification of the action down
	// to the gate, which needs it to re-decide an ALREADY OPEN card when the
	// operator changes the thread's mode while it is waiting. See
	// approval.Gate.ReleasePending.
	Ask(ctx context.Context, threadID, requestID string, rt event.RequestType, detail string, mutating bool) (event.Decision, error)
	SessionAccepted(threadID string) bool
}

// SSHToolService is the single choke point where an agent's remote action
// meets the user's permission policy. Every SSH-thread tool call — exec,
// read, list, grep, write — passes through here: it classifies the action
// (sshtool.Classify), reads the thread's current RuntimeMode (ThreadPolicy),
// and, when the two together say so, blocks on a human via ApprovalPrompter
// before the ShellRunner/RemoteFiles below it ever touches the remote host.
// Nothing about SSH transport, the orchestration engine, or a specific
// provider lives here — those arrive only as the consumer-side interfaces
// above, which is what lets this whole policy be tested with none of them
// present.
type SSHToolService struct {
	runner   ShellRunner
	files    RemoteFiles
	policy   ThreadPolicy
	prompter ApprovalPrompter
}

// NewSSHToolService builds an SSHToolService from its four collaborators.
// files may be nil for callers that only ever call Exec (as the plan's own
// exec-only tests do) — ReadFile/ListFiles/Grep/WriteFile would panic on a
// nil files, but Exec never touches it.
func NewSSHToolService(runner ShellRunner, files RemoteFiles, policy ThreadPolicy, prompter ApprovalPrompter) *SSHToolService {
	return &SSHToolService{runner: runner, files: files, policy: policy, prompter: prompter}
}

// ExecResult is the outcome of a remote command run through Exec. A
// non-zero ExitCode is not an error — it's data the agent reads, same as
// sshmgr.RunShell's own contract.
type ExecResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
}

// ErrDenied is returned when the user answers an approval prompt with
// decline or cancel. The action never reaches ShellRunner/RemoteFiles.
var ErrDenied = errors.New("denied by user")

// ErrApprovalTimeout is returned when nobody answered an approval card within
// approvalWindow. It exists as its own sentinel so the handler can tell a
// human who never answered apart from a network deadline: reporting "the
// operator declined" for an SSH dial that timed out is a lie the agent will
// act on.
var ErrApprovalTimeout = errors.New("approval timed out")

// approvalWindow bounds how long a tool call waits on a human (design §4.4).
// It is deliberately independent of any deadline the caller applied to the
// action itself: a command's own timeout measures the remote host's work, and
// spending it on an operator who is reading the command is how a 60-second
// exec limit turned into a 60-second limit on the person.
//
// A var, not a const, so tests can shorten it rather than sleep for ten
// minutes — the same "overridable in tests via direct reassignment" pattern
// worktree_file.go's resolveRipgrep already uses. Nothing in production
// writes it.
var approvalWindow = 10 * time.Minute

// toolRequestIDPrefix marks every approval request this service opens, so
// the orchestration Reactor can recognise a resolved request as having no
// provider counterpart (see ORCHESTRATION.md / the design's §4.4).
const toolRequestIDPrefix = "tool-"

// sessionShortcutApplies reports whether a standing DecisionAcceptForSession
// may skip a prompt under this mode. Only the two modes that gate mutations
// alone qualify: full-access never asks in the first place, and
// approval-required promises to ask every time.
func sessionShortcutApplies(mode provider.RuntimeMode) bool {
	return mode == provider.ModeAuto || mode == provider.ModeAutoAcceptEdits
}

// needsApproval implements the policy matrix (design §4.3): whether an action
// of the given Class must be gated behind a human decision under the given
// RuntimeMode.
//
// The table itself lives on provider.RuntimeMode, not here, because a SECOND
// caller now has to agree with it at a different moment: this function decides
// whether to OPEN a card, and approval.Gate.ReleasePending decides whether a
// card already open should close itself because the operator changed the mode
// while it was waiting. Two copies would drift, and a drifted copy shows up as
// a card that can never be dismissed.
func needsApproval(mode provider.RuntimeMode, class sshtool.Class) bool {
	return !mode.AllowsUnprompted(class == sshtool.ClassMutate)
}

// authorize runs the full gate for one action: it decides whether approval
// is required (an unknown thread — ThreadPolicy.ModeFor's ok == false —
// always requires it, matching the matrix's "unknown thread" row), honours
// a standing session accept for mutations, and otherwise blocks on
// prompter.Ask. A nil error means the caller may proceed.
func (svc *SSHToolService) authorize(ctx context.Context, sess sshtool.Session, class sshtool.Class, rt event.RequestType, detail string) error {
	mode, known := svc.policy.ModeFor(sess.ThreadID)
	if known && !needsApproval(mode, class) {
		return nil
	}
	// A standing "accept for session" answers later MUTATIONS, and only in the
	// modes whose whole job is to gate mutations. It must not apply in
	// approval-required, whose pill reads "Ask before commands and file
	// changes" — a mode that can be switched off by a click on an earlier card
	// is not the mode the operator selected. Nor when the thread's mode is
	// unknown, which fails closed everywhere else in this function.
	if known && class == sshtool.ClassMutate && sessionShortcutApplies(mode) &&
		svc.prompter.SessionAccepted(sess.ThreadID) {
		return nil
	}

	requestID, err := newToolRequestID()
	if err != nil {
		return err
	}
	// The wait gets its own deadline, derived from the caller's context so a
	// disconnecting client still cancels it, but never inheriting the caller's
	// (much shorter) action deadline.
	askCtx, cancel := context.WithTimeout(ctx, approvalWindow)
	defer cancel()
	decision, err := svc.prompter.Ask(askCtx, sess.ThreadID, requestID, rt, detail, class == sshtool.ClassMutate)
	if err != nil {
		// Distinguish "nobody answered in ten minutes" from "the caller went
		// away": only the former is a decision-shaped outcome.
		if ctx.Err() == nil && errors.Is(err, context.DeadlineExceeded) {
			return ErrApprovalTimeout
		}
		return err
	}
	if decision == event.DecisionDecline || decision == event.DecisionCancel {
		return ErrDenied
	}
	return nil
}

// Exec classifies command (sshtool.Classify), gates it per the thread's
// RuntimeMode, and — once authorized — runs it verbatim over the thread's
// SSH connection. A non-zero remote exit code comes back in ExecResult,
// not as err.
func (svc *SSHToolService) Exec(ctx context.Context, sess sshtool.Session, command string, execTimeout time.Duration) (ExecResult, error) {
	class := sshtool.Classify(command)
	if err := svc.authorize(ctx, sess, class, event.ReqCommandExecApproval, command); err != nil {
		return ExecResult{}, err
	}

	// execTimeout starts HERE, after the human has answered — it bounds the
	// remote command, not the operator. A zero value means "no limit beyond
	// the caller's own context".
	runCtx := ctx
	if execTimeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, execTimeout)
		defer cancel()
	}

	start := time.Now()
	stdout, stderr, exitCode, err := svc.runner.RunShell(runCtx, sess.ConnectionID, command)
	if err != nil {
		return ExecResult{}, err
	}
	return ExecResult{
		Stdout:     string(stdout),
		Stderr:     string(stderr),
		ExitCode:   exitCode,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

// ReadFile gates a remote file read per the thread's RuntimeMode (reads are
// only gated in approval-required mode, or for an unknown thread) and, once
// authorized, returns the file's contents.
func (svc *SSHToolService) ReadFile(ctx context.Context, sess sshtool.Session, path string) (SSHFileContent, error) {
	if err := svc.authorize(ctx, sess, sshtool.ClassRead, event.ReqFileReadApproval, path); err != nil {
		return SSHFileContent{}, err
	}
	return svc.files.Read(ctx, sess.ConnectionID, path)
}

// ListFiles gates a remote directory listing the same way ReadFile gates a
// file read, then lists path's entries.
func (svc *SSHToolService) ListFiles(ctx context.Context, sess sshtool.Session, path string) ([]SSHFileEntry, error) {
	if err := svc.authorize(ctx, sess, sshtool.ClassRead, event.ReqFileReadApproval, path); err != nil {
		return nil, err
	}
	return svc.files.List(ctx, sess.ConnectionID, path)
}

// Grep gates a remote content search the same way ReadFile gates a file
// read, then searches for query using the connection's default grep
// options.
func (svc *SSHToolService) Grep(ctx context.Context, sess sshtool.Session, query string) (GrepResult, error) {
	if err := svc.authorize(ctx, sess, sshtool.ClassRead, event.ReqFileReadApproval, query); err != nil {
		return GrepResult{}, err
	}
	return svc.files.Grep(ctx, sess.ConnectionID, query, GrepOptions{})
}

// WriteFile always gates as a mutation — writing a remote file is never
// read-only — subject to the same RuntimeMode matrix and session-accept
// short-circuit as a mutating Exec, then writes content to path.
func (svc *SSHToolService) WriteFile(ctx context.Context, sess sshtool.Session, path, content string) (SSHFileContent, error) {
	if err := svc.authorize(ctx, sess, sshtool.ClassMutate, event.ReqFileChangeApproval, path); err != nil {
		return SSHFileContent{}, err
	}
	return svc.files.Write(ctx, sess.ConnectionID, path, content)
}

// newToolRequestID mints a "tool-" + 16 hex character request id (8 random
// bytes from crypto/rand) for one approval card. Unguessable is the only
// property that matters — it is a correlation id, not a credential.
func newToolRequestID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return toolRequestIDPrefix + hex.EncodeToString(buf), nil
}
