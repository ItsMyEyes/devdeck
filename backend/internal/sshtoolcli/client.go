package sshtoolcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sessionEnvVar, when set, names the session file to load directly,
// overriding the default ./.devdeck/session.json lookup relative to the
// workspace directory. See loadBinding.
const sessionEnvVar = "DEVDECK_SSH_SESSION"

// binding mirrors sshthread.Binding's JSON shape (the .devdeck/session.json
// file sshthread.Seed writes into every SSH-thread workspace). It is
// declared locally instead of imported so this binary — a small HTTP
// client an agent process shells out to — carries none of the
// orchestration/store package graph sshthread pulls in.
type binding struct {
	// HubURL is the base URL of the DevDeck API the helper calls.
	HubURL string `json:"hubUrl"`
	// ThreadID is the chat thread this workspace belongs to.
	ThreadID string `json:"threadId"`
	// ConnectionID is the SSH connection every helper call is pinned to.
	// It is informational only here — the token, not this field, is what
	// actually scopes each request server-side.
	ConnectionID string `json:"connectionId"`
	// Label is the connection's human-facing name.
	Label string `json:"label"`
	// Host is the remote hostname or address.
	Host string `json:"host"`
	// User is the remote login user.
	User string `json:"user"`
	// Token authorises every request this client makes.
	Token string `json:"token"`
}

// loadBinding resolves the session binding for the workspace at dir: from
// $DEVDECK_SSH_SESSION if that env var is set, otherwise from
// dir/.devdeck/session.json. dir is normally the process's own working
// directory — the per-thread workspace sshthread.Seed created, which the
// agent process is spawned into.
func loadBinding(dir string) (binding, error) {
	path := os.Getenv(sessionEnvVar)
	if path == "" {
		path = filepath.Join(dir, ".devdeck", "session.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return binding{}, fmt.Errorf("read session file %s: %w", path, err)
	}
	var b binding
	if err := json.Unmarshal(raw, &b); err != nil {
		return binding{}, fmt.Errorf("parse session file %s: %w", path, err)
	}
	if b.HubURL == "" || b.Token == "" {
		return binding{}, fmt.Errorf("session file %s is missing hubUrl or token", path)
	}
	return b, nil
}

// httpClient is shared by every client call. Its timeout is generous on
// purpose: a mutating call can legitimately block for minutes while a human
// answers an approval card in the chat UI (design §4.4's 10-minute cap), and
// that wait must come back as a normal (if slow) response rather than a
// client-side timeout indistinguishable from a dead hub.
var httpClient = &http.Client{Timeout: 11 * time.Minute}

// client calls DevDeck's /api/agent-tools/ssh/* routes over HTTP, using the
// bearer token that both authenticates this thread's calls and implicitly
// selects the one SSH connection they may reach — the connection id is
// never a request parameter (design §4.1).
type client struct {
	hubURL string
	token  string
}

// newClient builds a client from a resolved binding.
func newClient(b binding) *client {
	return &client{hubURL: b.HubURL, token: b.Token}
}

// execRequest is the body of POST /api/agent-tools/ssh/exec.
type execRequest struct {
	Command string `json:"command"`
}

// execResult mirrors service.ExecResult. A non-zero ExitCode is not a
// client-side error — it is the remote command's own outcome.
type execResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
}

// fileContent mirrors service.SSHFileContent, the response shape shared by
// GET /api/agent-tools/ssh/file and PUT /api/agent-tools/ssh/file.
type fileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// fileEntry mirrors service.SSHFileEntry, one item within a fileListing.
type fileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// fileListing is the response body of GET /api/agent-tools/ssh/files: the
// handler wraps []service.SSHFileEntry under an "entries" key.
type fileListing struct {
	Entries []fileEntry `json:"entries"`
}

// grepMatch mirrors service.GrepMatch, one matched line within a
// grepFileMatch.
type grepMatch struct {
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Text   string `json:"text"`
}

// grepFileMatch mirrors service.GrepFileMatch, every grepMatch found in one
// remote file.
type grepFileMatch struct {
	Path    string      `json:"path"`
	Matches []grepMatch `json:"matches"`
}

// grepResult mirrors service.GrepResult, the response body of
// GET /api/agent-tools/ssh/grep.
type grepResult struct {
	Engine      string          `json:"engine"`
	RgAvailable bool            `json:"rgAvailable"`
	Truncated   bool            `json:"truncated"`
	Files       []grepFileMatch `json:"files"`
}

// writeFileRequest is the body of PUT /api/agent-tools/ssh/file.
type writeFileRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// apiError is the {"error":"..."} envelope every non-2xx DevDeck API
// response uses (CONTRACTS.md).
type apiError struct {
	Error string `json:"error"`
}

// apiErrorMessage extracts the "error" field from a non-2xx response body,
// falling back to the raw body (or a placeholder) when it isn't that shape,
// so a truly unexpected failure still surfaces something readable.
func apiErrorMessage(raw []byte) string {
	var e apiError
	if err := json.Unmarshal(raw, &e); err == nil && e.Error != "" {
		return e.Error
	}
	if msg := strings.TrimSpace(string(raw)); msg != "" {
		return msg
	}
	return "(no response body)"
}

// sessionExpiredErr reports a 401: this workspace's thread token is no
// longer valid — typically because the hub restarted or the chat session
// ended. No retry from here can fix that; a fresh token only comes from a
// new session start, so the message tells the reader (a model) to stop and
// say so rather than keep trying.
func sessionExpiredErr(raw []byte) error {
	return fmt.Errorf("session expired: the operator needs to restart the chat (%s)", apiErrorMessage(raw))
}

// deniedErr reports a 403 — the operator declined the action, or an
// approval prompt timed out waiting for them (the hub reports both the same
// way). detail names exactly what was declined ("reading \"/etc/shadow\"",
// the exec command quoted verbatim, ...), because exit code 77 exists so the
// model reading it knows precisely what to stop retrying and what to ask
// the operator about instead.
func deniedErr(raw []byte, detail string) error {
	return fmt.Errorf("denied by user: the operator declined %s — stop and ask them what to do instead", detail)
}

// hubErr reports any other non-2xx response — most often a 502 because the
// remote SSH host itself is unreachable.
func hubErr(status int, raw []byte) error {
	return fmt.Errorf("devdeck hub returned %d: %s", status, apiErrorMessage(raw))
}

// requestJSON sends one authenticated request to path and, on a 200
// response, decodes the body into out (out may be nil). It returns the raw
// response body alongside the status code so callers can build a
// status-specific, action-specific error message; err is non-nil only for a
// transport-level failure (couldn't reach the hub, couldn't parse a 200
// body) — a non-2xx status is not itself an error here, since 401/403/502
// each mean something different to different callers.
func (c *client) requestJSON(method, path string, body, out any) (status int, raw []byte, err error) {
	var reqBody io.Reader
	if body != nil {
		encoded, mErr := json.Marshal(body)
		if mErr != nil {
			return 0, nil, fmt.Errorf("encode request body: %w", mErr)
		}
		reqBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequest(method, c.hubURL+path, reqBody)
	if err != nil {
		return 0, nil, fmt.Errorf("build request to %s: %w", c.hubURL, err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("reach devdeck hub at %s: %w", c.hubURL, err)
	}
	defer resp.Body.Close()

	raw, err = io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, fmt.Errorf("read response from devdeck hub: %w", err)
	}

	if resp.StatusCode == http.StatusOK && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return 0, nil, fmt.Errorf("parse response from devdeck hub: %w", err)
		}
	}
	return resp.StatusCode, raw, nil
}

// do runs one requestJSON call and maps its outcome onto this CLI's exit
// codes: 0 for a 2xx response, 1 for a transport failure or a 401, 77 for a
// 403. forbiddenDetail supplies the action description a 403's error
// message should name; it is unused otherwise.
func (c *client) do(method, path string, body, out any, forbiddenDetail string) (int, error) {
	status, raw, err := c.requestJSON(method, path, body, out)
	if err != nil {
		return 1, err
	}
	switch status {
	case http.StatusOK:
		return 0, nil
	case http.StatusUnauthorized:
		return 1, sessionExpiredErr(raw)
	case http.StatusForbidden:
		return 77, deniedErr(raw, forbiddenDetail)
	default:
		return 1, hubErr(status, raw)
	}
}

// exec runs command verbatim on the thread's remote host
// (POST /api/agent-tools/ssh/exec). A non-zero remote exit code maps to CLI
// exit code 2 with err == nil — the command reached the host and produced
// data, not a client-side failure.
func (c *client) exec(command string) (execResult, int, error) {
	var res execResult
	code, err := c.do(http.MethodPost, "/api/agent-tools/ssh/exec", execRequest{Command: command}, &res, fmt.Sprintf("%q", command))
	if err != nil {
		return execResult{}, code, err
	}
	if res.ExitCode != 0 {
		return res, 2, nil
	}
	return res, 0, nil
}

// read fetches a remote file's contents (GET /api/agent-tools/ssh/file).
func (c *client) read(path string) (fileContent, int, error) {
	var res fileContent
	code, err := c.do(http.MethodGet, "/api/agent-tools/ssh/file?path="+url.QueryEscape(path), nil, &res, fmt.Sprintf("reading %q", path))
	return res, code, err
}

// list fetches a remote directory's entries (GET /api/agent-tools/ssh/files).
func (c *client) list(path string) (fileListing, int, error) {
	var res fileListing
	code, err := c.do(http.MethodGet, "/api/agent-tools/ssh/files?path="+url.QueryEscape(path), nil, &res, fmt.Sprintf("listing %q", path))
	return res, code, err
}

// grep searches the remote filesystem for pattern
// (GET /api/agent-tools/ssh/grep).
func (c *client) grep(pattern string) (grepResult, int, error) {
	var res grepResult
	code, err := c.do(http.MethodGet, "/api/agent-tools/ssh/grep?q="+url.QueryEscape(pattern), nil, &res, fmt.Sprintf("searching for %q", pattern))
	return res, code, err
}

// write overwrites a remote file with content (PUT /api/agent-tools/ssh/file).
// Always a mutation server-side, so it is always eligible to be gated.
func (c *client) write(path, content string) (fileContent, int, error) {
	var res fileContent
	code, err := c.do(http.MethodPut, "/api/agent-tools/ssh/file", writeFileRequest{Path: path, Content: content}, &res, fmt.Sprintf("writing to %q", path))
	return res, code, err
}
