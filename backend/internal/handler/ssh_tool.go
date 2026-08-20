package handler

import (
	"context"
	"errors"
	"net/http"
	"time"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/sshtool"
)

// sshToolService is the subset of *service.SSHToolService this handler
// needs, declared locally (rather than importing the concrete type
// directly) so tests can substitute a fake with no real SSH connection,
// orchestration engine, or approval gate behind it. Its method set matches
// *service.SSHToolService's exactly, so the concrete type satisfies this
// interface with no adapter required at the call site that constructs it.
type sshToolService interface {
	Exec(ctx context.Context, sess sshtool.Session, command string, execTimeout time.Duration) (service.ExecResult, error)
	ReadFile(ctx context.Context, sess sshtool.Session, path string) (service.SSHFileContent, error)
	ListFiles(ctx context.Context, sess sshtool.Session, path string) ([]service.SSHFileEntry, error)
	Grep(ctx context.Context, sess sshtool.Session, query string) (service.GrepResult, error)
	WriteFile(ctx context.Context, sess sshtool.Session, path, content string) (service.SSHFileContent, error)
}

// SSHToolHandler exposes an SSHToolService over the token-scoped
// /api/agent-tools/ssh/* routes the devdeck-ssh helper CLI calls. Every
// method resolves its sshtool.Session from the request context
// (ThreadSessionFrom, populated by RequireThreadToken) rather than from a
// path, query, or body parameter, so the connection a call operates on is
// fixed entirely by which token authenticated the request — nothing the
// caller writes into the request body can change it.
type SSHToolHandler struct {
	svc sshToolService
}

// NewSSHToolHandler builds an SSHToolHandler around svc.
func NewSSHToolHandler(svc sshToolService) *SSHToolHandler {
	return &SSHToolHandler{svc: svc}
}

// execRequest is the body of POST /api/agent-tools/ssh/exec. It
// deliberately has no connection/thread field: the connection comes from
// the request's sshtool.Session alone.
type execRequest struct {
	Command    string `json:"command"`
	TimeoutSec int    `json:"timeoutSec,omitempty"`
}

const (
	defaultExecTimeoutSec = 60
	minExecTimeoutSec     = 1
	maxExecTimeoutSec     = 900
)

// clampExecTimeoutSec applies execRequest.TimeoutSec's default (60s, used
// whenever the field is absent/zero) and bounds (1..900s).
func clampExecTimeoutSec(sec int) int {
	switch {
	case sec == 0:
		return defaultExecTimeoutSec
	case sec < minExecTimeoutSec:
		return minExecTimeoutSec
	case sec > maxExecTimeoutSec:
		return maxExecTimeoutSec
	default:
		return sec
	}
}

// Exec runs a remote command over the thread's SSH connection, gated by the
// thread's approval policy (SSHToolService.Exec). A non-zero remote exit
// code is not an error: it comes back as exitCode in a 200 response body.
func (h *SSHToolHandler) Exec(w http.ResponseWriter, r *http.Request) {
	sess, ok := ThreadSessionFrom(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body execRequest
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// The request context goes down untouched; timeoutSec travels as a value
	// so the service can start its clock AFTER any approval, not before it.
	// Wrapping the whole call in that deadline — the shape this handler used
	// to have — spent a 60-second command budget on the operator reading the
	// approval card, so every exec approval expired in a minute while the
	// design promised ten.
	result, err := h.svc.Exec(r.Context(), sess, body.Command,
		time.Duration(clampExecTimeoutSec(body.TimeoutSec))*time.Second)
	if writeSSHToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ReadFile returns a remote file's contents (SSHToolService.ReadFile),
// gated by the thread's approval policy.
func (h *SSHToolHandler) ReadFile(w http.ResponseWriter, r *http.Request) {
	sess, ok := ThreadSessionFrom(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	content, err := h.svc.ReadFile(r.Context(), sess, r.URL.Query().Get("path"))
	if writeSSHToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

// ListFiles lists a remote directory's entries (SSHToolService.ListFiles),
// gated by the thread's approval policy. The response wraps the entries
// under an "entries" key, matching the route's documented response shape.
func (h *SSHToolHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	sess, ok := ThreadSessionFrom(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	entries, err := h.svc.ListFiles(r.Context(), sess, r.URL.Query().Get("path"))
	if writeSSHToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// Grep searches the remote filesystem for a query string
// (SSHToolService.Grep), gated by the thread's approval policy, and returns
// its service.GrepResult verbatim.
func (h *SSHToolHandler) Grep(w http.ResponseWriter, r *http.Request) {
	sess, ok := ThreadSessionFrom(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	result, err := h.svc.Grep(r.Context(), sess, r.URL.Query().Get("q"))
	if writeSSHToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// writeFileRequest is the body of PUT /api/agent-tools/ssh/file. It
// deliberately has no connection/thread field, same as execRequest.
type writeFileRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// WriteFile overwrites a remote file (SSHToolService.WriteFile), always
// gated as a mutation by the thread's approval policy.
func (h *SSHToolHandler) WriteFile(w http.ResponseWriter, r *http.Request) {
	sess, ok := ThreadSessionFrom(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body writeFileRequest
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	content, err := h.svc.WriteFile(r.Context(), sess, body.Path, body.Content)
	if writeSSHToolErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

// writeSSHToolErr maps an SSHToolService error onto the response, per the
// design's §8 error table: service.ErrDenied -> 403 "denied by user";
// service.ErrApprovalTimeout -> 403 "approval timed out"; anything else ->
// 502 with the error's own message, since by the time an error reaches this
// handler unclassified it came from the remote host or transport, not from
// request validation. Returns true when it wrote a response (i.e. err was
// non-nil). Named distinctly from tools.go's own writeToolErr (an unrelated
// Tools-module helper) to avoid a redeclaration in this package.
//
// A bare context.DeadlineExceeded is deliberately NOT mapped to "approval
// timed out" any more. Only the service knows whether a deadline was the
// approval window or the command's own clock, and it says so with a sentinel;
// sniffing the context error here reported an SSH dial that timed out as a
// decision the operator made, which is a lie the agent acts on.
func writeSSHToolErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, service.ErrDenied):
		writeErr(w, http.StatusForbidden, "denied by user")
	case errors.Is(err, service.ErrApprovalTimeout):
		writeErr(w, http.StatusForbidden, "approval timed out")
	case errors.Is(err, context.DeadlineExceeded):
		writeErr(w, http.StatusGatewayTimeout, "remote command timed out")
	default:
		writeErr(w, http.StatusBadGateway, err.Error())
	}
	return true
}
