# SSH DevOps Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each saved SSH connection a chat panel whose agent can read, diagnose, and — behind an approval gate — change the remote host, through DevDeck's own API rather than its own SSH client.

**Architecture:** SSH threads (`ssh:<connectionId>`) run on the existing orchestration engine and `/ws/agent` socket, hosted by the hub process. The agent CLI is spawned with its cwd set to a per-thread workspace seeded with skill files; it calls a helper binary (`devdeck-ssh`) that talks to a token-authenticated REST group (`/api/agent-tools/ssh/*`). Mutating commands block in that handler until the user answers an approval card, reusing the approval UI that already exists.

**Tech Stack:** Go 1.25 (stdlib `net/http`, `golang.org/x/crypto/ssh` via `internal/sshmgr`), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-ssh-devops-chat-design.md`

## Global Constraints

- Go module path is `devdeck/backend`; every package lives under `devdeck/backend/internal/`.
- All API errors use the `{"error":"message"}` envelope via `handler.writeErr` — never a raw error string, never a different shape.
- Handlers return void and write via `writeJSON` / `writeErr`; bodies parse via `decodeBody`.
- No new `port.Store` methods and no schema change: thread tokens are in-memory.
- Frontend imports use the `@/*` alias; `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- Verification per task: `cd backend && go vet ./... && go test ./...` for Go tasks; `cd frontend && npm run typecheck && npx vitest run <files>` for frontend tasks. Both were clean at baseline on 2026-08-17 except one pre-existing Monaco guard failure in the full `npm test` run — that failure is not a regression.
- The repo's pre-commit hook runs the full frontend typecheck. Do not bypass it with `--no-verify`; if it fails, the failure is yours to fix.
- Convergence files are touched by exactly one task each: `backend/cmd/server/main.go` → Task 9, `frontend/src/store/useDevDeckStore.ts` → Task 12. No other task may edit them.
- TDD: write the failing test, run it and see it fail, write the minimal implementation, run it and see it pass, commit.

---

### Task 1: Command classifier

**Files:**
- Create: `backend/internal/sshtool/classify.go`
- Test: `backend/internal/sshtool/classify_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Class string`, `const ClassRead Class = "read"`, `const ClassMutate Class = "mutate"`, `func Classify(command string) Class`.

- [ ] **Step 1: Write the failing test**

```go
package sshtool

import "testing"

func TestClassifyReadOnlyCommands(t *testing.T) {
	for _, cmd := range []string{
		"ls -la /etc",
		"cat /etc/nginx/nginx.conf",
		"tail -n 200 /var/log/syslog",
		"journalctl -u nginx --since '1 hour ago'",
		"systemctl status nginx",
		"docker ps -a",
		"docker logs web --tail 50",
		"kubectl get pods -A",
		"git status",
		"df -h | grep /dev",
		"ps aux | grep node | wc -l",
	} {
		if got := Classify(cmd); got != ClassRead {
			t.Errorf("Classify(%q) = %q, want %q", cmd, got, ClassRead)
		}
	}
}

func TestClassifyMutatingCommands(t *testing.T) {
	for _, cmd := range []string{
		"systemctl restart nginx",
		"sudo systemctl status nginx", // sudo is always privileged
		"rm -rf /tmp/build",
		"docker compose up -d",
		"kubectl delete pod web",
		"git checkout main",
		"echo hi > /etc/motd",
		"cat /etc/passwd >> /tmp/leak",
		"ls $(rm -rf /tmp/x)",
		"tail -f /var/log/app.log && systemctl restart app",
		"curl https://example.com -o /tmp/x",
		"somethingnobodyknows --flag",
		"",
	} {
		if got := Classify(cmd); got != ClassMutate {
			t.Errorf("Classify(%q) = %q, want %q", cmd, got, ClassMutate)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshtool/ -run TestClassify -v`
Expected: FAIL — package/symbols undefined.

- [ ] **Step 3: Write minimal implementation**

`classify.go` requirements, in this order:

1. `Class` type with `ClassRead` / `ClassMutate`.
2. `Classify` returns `ClassMutate` for an empty/whitespace-only command.
3. Reject outright (⇒ `ClassMutate`) if the raw string contains `>`, `<`, `` ` ``, `$(`, or the word `sudo` as a token.
4. Split the command on `|`, `&&`, `||`, `;` into segments. Every segment must classify read-only or the whole command is `ClassMutate`.
5. Per segment: take the first field. Strip a leading `env`/`command` wrapper is **not** required — an unknown first word is `ClassMutate`.
6. Unconditional read-only binaries: `ls cat head tail grep egrep fgrep rg find stat file wc df du free uptime uname whoami id ps top journalctl dmesg hostname date env printenv ss netstat ip ping nproc lsblk lsof sensors`.
7. Subcommand-gated binaries — read-only only for these second words:
   - `systemctl`: `status show list-units list-unit-files is-active is-enabled cat`
   - `docker`: `ps logs inspect images stats top version info`
   - `kubectl`: `get describe logs top version explain`
   - `git`: `status log diff show branch remote`
   - `curl`, `wget`: read-only only when no `-o`, `-O`, `--output`, `--remote-name` flag appears in that segment.
8. Everything else is `ClassMutate`.

Document in the file's doc comment that the default is `ClassMutate` on purpose: a misread costs one click, a miswrite costs an incident.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/sshtool/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshtool/classify.go backend/internal/sshtool/classify_test.go
git commit -m "feat(sshtool): classify remote commands as read-only or mutating"
```

---

### Task 2: Blocking approval gate

**Files:**
- Create: `backend/internal/agentcore/approval/gate.go`
- Test: `backend/internal/agentcore/approval/gate_test.go`

**Interfaces:**
- Consumes: existing `approval.Broker` interface and `event.Decision` (`backend/internal/agentcore/event/event.go:266`).
- Produces:
  - `func NewGate() *Gate`
  - `func (g *Gate) Open(threadID, requestID string)` / `Resolve(requestID string, d event.Decision) error` / `CancelThread(threadID string)` — satisfies `Broker`.
  - `func (g *Gate) Await(ctx context.Context, threadID, requestID string) (event.Decision, error)`
  - `func (g *Gate) SessionAccepted(threadID string) bool`
  - `func (g *Gate) ClearSession(threadID string)`

Semantics: `Await` registers the request and blocks. `Resolve` delivers to the waiter and returns `ErrUnknownRequest` if there is none. `CancelThread` resolves every pending request on that thread with `event.DecisionDecline` and clears its session-accept flag. A `Resolve` carrying `event.DecisionAcceptForSession` also sets the thread's session-accept flag. `Await` returns `ctx.Err()` if the context ends first, and the request is removed either way (no leaks).

- [ ] **Step 1: Write the failing test**

```go
package approval

import (
	"context"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
)

func TestAwaitReturnsResolvedDecision(t *testing.T) {
	g := NewGate()
	go func() {
		// Resolve may land before Await registers; the gate must tolerate
		// either order, so retry briefly.
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if err := g.Resolve("tool-1", event.DecisionAccept); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	d, err := g.Await(context.Background(), "ssh:c-1", "tool-1")
	if err != nil {
		t.Fatalf("Await: %v", err)
	}
	if d != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", d, event.DecisionAccept)
	}
}

func TestCancelThreadDeclinesPendingRequests(t *testing.T) {
	g := NewGate()
	done := make(chan event.Decision, 1)
	go func() {
		d, _ := g.Await(context.Background(), "ssh:c-1", "tool-2")
		done <- d
	}()
	waitForPending(t, g, "tool-2")
	g.CancelThread("ssh:c-1")
	select {
	case d := <-done:
		if d != event.DecisionDecline {
			t.Fatalf("decision = %q, want %q", d, event.DecisionDecline)
		}
	case <-time.After(time.Second):
		t.Fatal("Await did not return after CancelThread")
	}
}

func TestAwaitHonoursContextCancellation(t *testing.T) {
	g := NewGate()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Await(ctx, "ssh:c-1", "tool-3"); err == nil {
		t.Fatal("want error from cancelled context")
	}
	if err := g.Resolve("tool-3", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("request leaked: %v", err)
	}
}

func TestAcceptForSessionSetsThreadFlag(t *testing.T) {
	g := NewGate()
	go func() {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if err := g.Resolve("tool-4", event.DecisionAcceptForSession); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if _, err := g.Await(context.Background(), "ssh:c-2", "tool-4"); err != nil {
		t.Fatalf("Await: %v", err)
	}
	if !g.SessionAccepted("ssh:c-2") {
		t.Fatal("session-accept flag not set")
	}
	g.ClearSession("ssh:c-2")
	if g.SessionAccepted("ssh:c-2") {
		t.Fatal("session-accept flag survived ClearSession")
	}
}

func TestResolveUnknownRequest(t *testing.T) {
	if err := NewGate().Resolve("nope", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("err = %v, want ErrUnknownRequest", err)
	}
}

func waitForPending(t *testing.T, g *Gate, requestID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if g.pending(requestID) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("request %s never became pending", requestID)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/agentcore/approval/ -v`
Expected: FAIL — `NewGate` undefined.

- [ ] **Step 3: Write minimal implementation**

A `sync.Mutex`-guarded `map[string]chan event.Decision` keyed by requestID, plus `map[string]map[string]bool` of threadID → requestIDs, plus `map[string]bool` of session-accepted threads, plus an unexported `pending(requestID) bool` helper for the test. Channels are buffered (size 1) so `Resolve` never blocks on a waiter that has already given up. Add `var _ Broker = (*Gate)(nil)`.

Also verify: `go test ./internal/agentcore/approval/ -race`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/agentcore/approval/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/approval/gate.go backend/internal/agentcore/approval/gate_test.go
git commit -m "feat(approval): blocking gate with await, cancel, and accept-for-session"
```

---

### Task 3: Thread token store

**Files:**
- Create: `backend/internal/sshtool/token.go`
- Test: `backend/internal/sshtool/token_test.go`

**Interfaces:**
- Produces:
  - `type Session struct { ThreadID string; ConnectionID string }`
  - `func NewTokenStore() *TokenStore`
  - `func (s *TokenStore) Mint(threadID, connectionID string) string` — replaces any token already held by that thread
  - `func (s *TokenStore) Lookup(token string) (Session, bool)`
  - `func (s *TokenStore) RevokeThread(threadID string)`

- [ ] **Step 1: Write the failing test**

```go
package sshtool

import "testing"

func TestMintAndLookup(t *testing.T) {
	s := NewTokenStore()
	tok := s.Mint("ssh:c-1", "c-1")
	if len(tok) < 32 {
		t.Fatalf("token too short: %q", tok)
	}
	sess, ok := s.Lookup(tok)
	if !ok || sess.ThreadID != "ssh:c-1" || sess.ConnectionID != "c-1" {
		t.Fatalf("Lookup = %+v, %v", sess, ok)
	}
}

func TestMintReplacesPreviousTokenForThread(t *testing.T) {
	s := NewTokenStore()
	old := s.Mint("ssh:c-1", "c-1")
	fresh := s.Mint("ssh:c-1", "c-1")
	if old == fresh {
		t.Fatal("re-mint returned the same token")
	}
	if _, ok := s.Lookup(old); ok {
		t.Fatal("old token still valid after re-mint")
	}
	if _, ok := s.Lookup(fresh); !ok {
		t.Fatal("fresh token not valid")
	}
}

func TestRevokeThread(t *testing.T) {
	s := NewTokenStore()
	tok := s.Mint("ssh:c-1", "c-1")
	s.RevokeThread("ssh:c-1")
	if _, ok := s.Lookup(tok); ok {
		t.Fatal("token survived revocation")
	}
}

func TestLookupUnknownToken(t *testing.T) {
	if _, ok := NewTokenStore().Lookup("whatever"); ok {
		t.Fatal("unknown token accepted")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshtool/ -run 'TestMint|TestRevoke|TestLookup' -v`
Expected: FAIL — undefined symbols.

- [ ] **Step 3: Write minimal implementation**

`crypto/rand` 32 bytes hex-encoded; two maps (token→Session, threadID→token) under one `sync.RWMutex`. Doc comment states tokens are process-lifetime only and re-minted on each session start, which is why no persistence is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/sshtool/ -race -v`
Expected: PASS (Task 1's tests still pass too).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshtool/token.go backend/internal/sshtool/token_test.go
git commit -m "feat(sshtool): in-memory per-thread token store"
```

---

### Task 4: Raw shell exec over the pooled SSH connection

**Files:**
- Modify: `backend/internal/sshmgr/exec.go` (append; do not touch `RunCommand`, `shellQuote`, `shellJoin`)
- Test: `backend/internal/sshmgr/exec_test.go` (append)

**Interfaces:**
- Consumes: `sshmgr.WithSSHClient` (`exec.go:19`), `*FilePool`.
- Produces: `func RunShell(ctx context.Context, pool *FilePool, connectionID, command string) (stdout, stderr []byte, exitCode int, err error)`

Unlike `RunCommand`, the command string is handed to the remote shell **verbatim** — pipelines and redirection are the point of this call, and everything reaching it has already been classified (Task 1) and, where required, approved (Task 6). A non-zero remote exit is **not** an error: it comes back as `exitCode` with `err == nil`, so the agent sees a failing command as data. Transport failures still return a non-nil `err`.

- [ ] **Step 1: Write the failing test**

This package already has an in-process SSH test server. The existing tests use
`addr, _ := startTestSSHServer(t, nil)` + `pool := newTestPool(t, addr)` and the
fixed connection id `"sc-test"` (see `exec_test.go:52`). Use the same three lines.

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshmgr/ -run TestRunShell -v`
Expected: FAIL — `RunShell` undefined.

- [ ] **Step 3: Write minimal implementation**

Mirror `RunCommand`'s structure: `WithSSHClient`, `client.NewSession()`, separate `bytes.Buffer` for stdout/stderr, `session.Run(command)`. Map `*ssh.ExitError` to `exitCode = e.ExitStatus(), err = nil`; map `*ssh.ExitMissingError` to `exitCode = -1, err = nil`; anything else is a real error.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/sshmgr/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshmgr/exec.go backend/internal/sshmgr/exec_test.go
git commit -m "feat(sshmgr): RunShell for verbatim remote commands with exit codes"
```

---

### Task 5: SSH tool service (policy + gate + ops)

**Files:**
- Create: `backend/internal/service/ssh_tool.go`
- Test: `backend/internal/service/ssh_tool_test.go`

**Interfaces:**
- Consumes: `sshtool.Classify` / `sshtool.Class` (Task 1), `event.RequestType` + `event.Decision`, `provider.RuntimeMode`.
- Produces (consumer-side interfaces declared **here**, implemented elsewhere):

```go
type ShellRunner interface {
	RunShell(ctx context.Context, connectionID, command string) (stdout, stderr []byte, exitCode int, err error)
}

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
	Ask(ctx context.Context, threadID, requestID string, rt event.RequestType, detail string) (event.Decision, error)
	SessionAccepted(threadID string) bool
}

type SSHToolService struct { ... }
func NewSSHToolService(runner ShellRunner, files RemoteFiles, policy ThreadPolicy, prompter ApprovalPrompter) *SSHToolService

type ExecResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
}

var ErrDenied = errors.New("denied by user")

func (svc *SSHToolService) Exec(ctx context.Context, sess sshtool.Session, command string) (ExecResult, error)
func (svc *SSHToolService) ReadFile(ctx context.Context, sess sshtool.Session, path string) (SSHFileContent, error)
func (svc *SSHToolService) ListFiles(ctx context.Context, sess sshtool.Session, path string) ([]SSHFileEntry, error)
func (svc *SSHToolService) Grep(ctx context.Context, sess sshtool.Session, query string) (GrepResult, error)
func (svc *SSHToolService) WriteFile(ctx context.Context, sess sshtool.Session, path, content string) (SSHFileContent, error)
```

Gate rules (spec §4.3), implemented in one unexported helper `needsApproval(mode provider.RuntimeMode, class sshtool.Class) bool`:

| mode | read | mutate |
|---|---|---|
| `provider.ModeFullAccess` | false | false |
| `provider.ModeAuto` | false | true |
| `provider.ModeAutoAcceptEdits` | false | true |
| `provider.ModeApprovalRequired` | true | true |
| unknown thread (no state) | true | true |

`SessionAccepted(threadID)` short-circuits an approval for `ClassMutate` only. `Exec` uses `event.ReqCommandExecApproval` with the command as detail; `WriteFile` uses `event.ReqFileChangeApproval` with the path. A `DecisionDecline`/`DecisionCancel` returns `ErrDenied`. Request ids are `"tool-" + 16 hex chars`.

- [ ] **Step 1: Write the failing test**

```go
package service

import (
	"context"
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/sshtool"
)

type fakeRunner struct {
	gotCommand string
	stdout     string
	exitCode   int
}

func (f *fakeRunner) RunShell(_ context.Context, _, command string) ([]byte, []byte, int, error) {
	f.gotCommand = command
	return []byte(f.stdout), nil, f.exitCode, nil
}

type fakePolicy struct{ mode provider.RuntimeMode }

func (f fakePolicy) ModeFor(string) (provider.RuntimeMode, bool) { return f.mode, true }

type fakePrompter struct {
	asked    int
	decision event.Decision
	lastType event.RequestType
	session  bool
}

func (f *fakePrompter) Ask(_ context.Context, _, _ string, rt event.RequestType, _ string) (event.Decision, error) {
	f.asked++
	f.lastType = rt
	return f.decision, nil
}
func (f *fakePrompter) SessionAccepted(string) bool { return f.session }

func sess() sshtool.Session { return sshtool.Session{ThreadID: "ssh:c-1", ConnectionID: "c-1"} }

func TestExecReadOnlySkipsApprovalInAutoMode(t *testing.T) {
	r := &fakeRunner{stdout: "ok"}
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	res, err := svc.Exec(context.Background(), sess(), "systemctl status nginx")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("asked for approval on a read-only command")
	}
	if res.Stdout != "ok" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}

func TestExecMutatingAsksAndRunsOnAccept(t *testing.T) {
	r := &fakeRunner{stdout: "restarted"}
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 1 {
		t.Fatalf("asked %d times, want 1", p.asked)
	}
	if p.lastType != event.ReqCommandExecApproval {
		t.Fatalf("requestType = %q", p.lastType)
	}
	if r.gotCommand != "systemctl restart nginx" {
		t.Fatalf("command reached runner as %q", r.gotCommand)
	}
}

func TestExecDeniedNeverRuns(t *testing.T) {
	r := &fakeRunner{}
	p := &fakePrompter{decision: event.DecisionDecline}
	svc := NewSSHToolService(r, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "rm -rf /srv"); !errors.Is(err, ErrDenied) {
		t.Fatalf("err = %v, want ErrDenied", err)
	}
	if r.gotCommand != "" {
		t.Fatalf("denied command still ran: %q", r.gotCommand)
	}
}

func TestApprovalRequiredGatesEvenReads(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionAccept}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeApprovalRequired}, p)

	if _, err := svc.Exec(context.Background(), sess(), "ls /etc"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 1 {
		t.Fatalf("read was not gated in approval-required mode")
	}
}

func TestFullAccessNeverGates(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionDecline}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeFullAccess}, p)

	if _, err := svc.Exec(context.Background(), sess(), "rm -rf /tmp/x"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("full-access mode asked for approval")
	}
}

func TestSessionAcceptSkipsRepeatApproval(t *testing.T) {
	p := &fakePrompter{decision: event.DecisionAccept, session: true}
	svc := NewSSHToolService(&fakeRunner{}, nil, fakePolicy{provider.ModeAuto}, p)

	if _, err := svc.Exec(context.Background(), sess(), "systemctl restart nginx"); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if p.asked != 0 {
		t.Fatalf("session-accepted thread was asked again")
	}
}

func TestNonZeroExitIsNotAnError(t *testing.T) {
	svc := NewSSHToolService(&fakeRunner{exitCode: 2}, nil, fakePolicy{provider.ModeFullAccess}, &fakePrompter{})
	res, err := svc.Exec(context.Background(), sess(), "ls /nope")
	if err != nil {
		t.Fatalf("non-zero exit surfaced as error: %v", err)
	}
	if res.ExitCode != 2 {
		t.Fatalf("exitCode = %d, want 2", res.ExitCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run 'TestExec|TestApprovalRequired|TestFullAccess|TestSession|TestNonZeroExit' -v`
Expected: FAIL — `NewSSHToolService` undefined.

- [ ] **Step 3: Write minimal implementation**

Write `ssh_tool.go` exactly to the interface block above. `WriteFile` mirrors `Exec`'s gate with `event.ReqFileChangeApproval` and `ClassMutate` always. `ReadFile`/`ListFiles`/`Grep` gate only when `needsApproval(mode, ClassRead)` is true, using `event.ReqFileReadApproval`. Use `time.Since` for `DurationMs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/ -run 'TestExec|TestApproval|TestFullAccess|TestSession|TestNonZero' -v && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/ssh_tool.go backend/internal/service/ssh_tool_test.go
git commit -m "feat(service): SSH tool service with runtime-mode approval policy"
```

---

### Task 6: Token middleware and agent-tools routes

**Files:**
- Create: `backend/internal/handler/threadtoken.go`
- Create: `backend/internal/handler/ssh_tool.go`
- Test: `backend/internal/handler/ssh_tool_test.go`

**Interfaces:**
- Consumes: `sshtool.TokenStore` (Task 3), `service.SSHToolService` + `service.ErrDenied` (Task 5), `writeJSON` / `writeErr` / `decodeBody`.
- Produces:
  - `func RequireThreadToken(store *sshtool.TokenStore) func(http.Handler) http.Handler`
  - `func ThreadSessionFrom(ctx context.Context) (sshtool.Session, bool)`
  - `func NewSSHToolHandler(svc sshToolService) *SSHToolHandler` where `sshToolService` is a handler-local interface matching the five service methods (so the test can fake it)
  - Methods `Exec`, `ReadFile`, `ListFiles`, `Grep`, `WriteFile`

Route shapes (registered in Task 9, asserted here through a local mux):

```
POST /api/agent-tools/ssh/exec
GET  /api/agent-tools/ssh/file
PUT  /api/agent-tools/ssh/file
GET  /api/agent-tools/ssh/files
GET  /api/agent-tools/ssh/grep
```

Status mapping: `service.ErrDenied` → `403 {"error":"denied by user"}`; `context.DeadlineExceeded` → `403 {"error":"approval timed out"}`; anything else → `502` with the error's message; a missing/unknown token → `401 {"error":"unauthorized"}`.

- [ ] **Step 1: Write the failing test**

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/sshtool"
)

type fakeToolSvc struct {
	gotSession sshtool.Session
	gotCommand string
	err        error
}

func (f *fakeToolSvc) Exec(_ context.Context, sess sshtool.Session, command string) (service.ExecResult, error) {
	f.gotSession, f.gotCommand = sess, command
	if f.err != nil {
		return service.ExecResult{}, f.err
	}
	return service.ExecResult{Stdout: "ok", ExitCode: 0}, nil
}
// ... the four file methods return zero values; fill them in to satisfy the interface.

func TestExecRequiresToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	mux := newToolMux(store, &fakeToolSvc{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"ls"}`))
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] == "" {
		t.Fatal("401 did not use the {\"error\":...} envelope")
	}
}

func TestExecDerivesConnectionFromToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	svc := &fakeToolSvc{}
	mux := newToolMux(store, svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"ls -la","connectionId":"c-999"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
	// The body's connectionId must be ignored entirely — the token decides.
	if svc.gotSession.ConnectionID != "c-1" {
		t.Fatalf("connection = %q, want c-1 (from token)", svc.gotSession.ConnectionID)
	}
	if svc.gotCommand != "ls -la" {
		t.Fatalf("command = %q", svc.gotCommand)
	}
}

func TestExecDeniedReturns403(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{err: service.ErrDenied})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"rm -rf /"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}
```

Write `newToolMux(store, svc)` as a test helper in the same file: it builds an `http.ServeMux` with the five routes wrapped in `RequireThreadToken(store)`, exactly as Task 9 will register them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestExec -v`
Expected: FAIL — undefined symbols.

- [ ] **Step 3: Write minimal implementation**

`threadtoken.go`: read `Authorization: Bearer …` (fall back to `?key=` for parity with `keyFromRequest`), look the token up, stash the `sshtool.Session` in the request context under an unexported key type, else `writeErr(w, 401, "unauthorized")`.

`ssh_tool.go`: five thin handlers. Each pulls the session from the context, decodes its input, calls the service, maps errors per the table above. The exec request struct has exactly one field, `Command string \`json:"command"\``, plus `TimeoutSec int \`json:"timeoutSec,omitempty"\`` (clamped to 1–900, default 60, applied with `context.WithTimeout`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -run TestExec -v && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/threadtoken.go backend/internal/handler/ssh_tool.go backend/internal/handler/ssh_tool_test.go
git commit -m "feat(handler): token-scoped /api/agent-tools/ssh routes"
```

---

### Task 7: Thread namespace, event injection, prompter

**Files:**
- Create: `backend/internal/agentcore/orchestration/sshthread.go`
- Create: `backend/internal/agentcore/orchestration/toolprompt.go`
- Modify: `backend/internal/agentcore/orchestration/workers.go` (add `Inject`; skip provider reply for `tool-` request ids)
- Test: `backend/internal/agentcore/orchestration/sshthread_test.go`

**Interfaces:**
- Consumes: `approval.Gate` (Task 2), `event.Event`, existing `Ingestion`, `WorktreeIDForThread`.
- Produces:
  - `const SSHThreadPrefix = "ssh:"`
  - `func IsSSHThread(threadID string) bool`
  - `func SSHConnectionIDForThread(threadID string) string` — strips the prefix and any `::chat-N` suffix
  - `func SSHThreadID(connectionID string) string`
  - `const ToolRequestPrefix = "tool-"`
  - `func (in *Ingestion) Inject(ctx context.Context, ev event.Event) error` — exported wrapper over the existing `handle`
  - `type ToolApprovalPrompter struct { Ingestion *Ingestion; Gate *approval.Gate }` with
    `Ask(ctx, threadID, requestID string, rt event.RequestType, detail string) (event.Decision, error)` and
    `SessionAccepted(threadID string) bool`

`Ask` injects `event.Event{Type: event.RequestOpened, ThreadID, RequestID, Payload: &event.RequestOpenedPayload{RequestType: rt, Detail: detail, Options: []event.Decision{event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline}}}`, calls `Gate.Await`, then injects `event.Event{Type: event.RequestResolved, ThreadID, RequestID, Payload: &event.RequestResolvedPayload{RequestType: rt, Decision: d}}` before returning — including on the error paths, so no card is ever orphaned.

In `workers.go`'s `EvtThreadApprovalResponseRequested` case, after `Broker.Resolve` succeeds, return early when `strings.HasPrefix(p.RequestID, ToolRequestPrefix)`: a tool-gate request has no provider counterpart, and calling `Provider.RespondToRequest` for it would fail on a thread with no live provider request.

- [ ] **Step 1: Write the failing test**

```go
package orchestration

import "testing"

func TestSSHThreadNamespace(t *testing.T) {
	if !IsSSHThread("ssh:c-1") {
		t.Fatal("ssh:c-1 not recognised as an SSH thread")
	}
	if IsSSHThread("w-abc") || IsSSHThread("w-abc::chat-2") {
		t.Fatal("worktree thread misread as SSH")
	}
	if got := SSHConnectionIDForThread("ssh:c-1::chat-3"); got != "c-1" {
		t.Fatalf("connection id = %q, want c-1", got)
	}
	if got := SSHThreadID("c-9"); got != "ssh:c-9" {
		t.Fatalf("thread id = %q, want ssh:c-9", got)
	}
}

func TestWorktreeIDForThreadStillIgnoresSSHThreads(t *testing.T) {
	// Guards the existing worktree path: it must not try to resolve an SSH id.
	if got := WorktreeIDForThread("w-abc::chat-2"); got != "w-abc" {
		t.Fatalf("worktree id = %q", got)
	}
}
```

Plus the prompter test, built on this package's own `MemStore` (`memstore.go:21`)
and `NewIngestion` (`workers.go:71`):

```go
func TestToolApprovalPrompterOpensAwaitsAndResolves(t *testing.T) {
	st := NewMemStore()
	n := 0
	eng := NewEngine(EngineOptions{Store: st, NewID: func() string { n++; return "ae-" + strconv.Itoa(n) }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go eng.Run(ctx)

	if _, err := eng.Dispatch(ctx, Command{
		CommandID: "c-create", Type: CmdThreadCreate, ThreadID: "ssh:sc-1",
		Payload: []byte(`{"instanceId":"claude:default"}`),
	}); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	gate := approval.NewGate()
	in := NewIngestion(eng, gate, func() string { n++; return "ae-" + strconv.Itoa(n) })
	p := &ToolApprovalPrompter{Ingestion: in, Gate: gate}

	go func() {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if err := gate.Resolve("tool-1", event.DecisionAccept); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	d, err := p.Ask(ctx, "ssh:sc-1", "tool-1", event.ReqCommandExecApproval, "systemctl restart nginx")
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if d != event.DecisionAccept {
		t.Fatalf("decision = %q, want %q", d, event.DecisionAccept)
	}

	evts, err := st.EventsSince("ssh:sc-1", 0)
	if err != nil {
		t.Fatalf("EventsSince: %v", err)
	}
	var sawOpened, sawResolved bool
	for _, e := range evts {
		if strings.Contains(string(e.Payload), string(event.RequestOpened)) {
			sawOpened = true
		}
		if strings.Contains(string(e.Payload), string(event.RequestResolved)) {
			sawResolved = true
		}
	}
	if !sawOpened || !sawResolved {
		t.Fatalf("event log missing request lifecycle: opened=%v resolved=%v", sawOpened, sawResolved)
	}
}
```

If `MemStore`'s replay method is named something other than `EventsSince`, use the
name it actually has — read `memstore.go` before writing the assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -run 'TestSSHThread|TestWorktreeIDForThread' -v`
Expected: FAIL — undefined symbols.

- [ ] **Step 3: Write minimal implementation**

Implement the three files as specified. `SSHConnectionIDForThread` must handle both `ssh:c-1` and `ssh:c-1::chat-2`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/agentcore/... -race && go vet ./...`
Expected: PASS, and every pre-existing orchestration test still passes.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/
git commit -m "feat(orchestration): SSH thread namespace, event injection, tool approval prompter"
```

---

### Task 8: Per-thread workspace and skill files

**Files:**
- Create: `backend/internal/sshthread/workspace.go`
- Create: `backend/internal/sshthread/assets/AGENTS.md`
- Create: `backend/internal/sshthread/assets/SKILL.md`
- Test: `backend/internal/sshthread/workspace_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks (kept dependency-free on purpose).
- Produces:

```go
type Binding struct {
	HubURL       string `json:"hubUrl"`
	ThreadID     string `json:"threadId"`
	ConnectionID string `json:"connectionId"`
	Label        string `json:"label"`
	Host         string `json:"host"`
	User         string `json:"user"`
	Token        string `json:"token"`
}

// Seed creates (or refreshes) the workspace for one thread and returns its
// absolute path. Safe to call on every session start.
func Seed(root string, b Binding) (string, error)
func SlugForThread(threadID string) string
```

Layout produced under `root/<slug>/`: `AGENTS.md`, `CLAUDE.md` (same bytes), `.claude/skills/devops-ssh/SKILL.md`, `.devdeck/session.json` (mode `0600`). Directories are `0700`. The markdown files are embedded with `//go:embed assets/*.md`.

`SKILL.md` must carry front matter in the shape `detect.ReadSkills` parses (read `backend/internal/detect/skills.go`'s `parseSkill` first and match it exactly) and must document, with real examples, every helper CLI command from Task 10 plus these rules: read freely, expect a wait when a command changes state, treat exit code 77 as "the user said no — stop and ask", never print the contents of `.devdeck/session.json`.

- [ ] **Step 1: Write the failing test**

```go
package sshthread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeedWritesWorkspace(t *testing.T) {
	root := t.TempDir()
	dir, err := Seed(root, Binding{
		HubURL: "http://127.0.0.1:8989", ThreadID: "ssh:c-1", ConnectionID: "c-1",
		Label: "Superapps Dev1", Host: "172.27.168.190", User: "clouduser", Token: "secret-token",
	})
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md", ".claude/skills/devops-ssh/SKILL.md", ".devdeck/session.json"} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			t.Errorf("missing %s: %v", rel, err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, ".devdeck/session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("session.json mode = %v, want 0600", info.Mode().Perm())
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".devdeck/session.json"))
	var b Binding
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatalf("session.json is not valid JSON: %v", err)
	}
	if b.Token != "secret-token" || b.ConnectionID != "c-1" {
		t.Fatalf("binding round-trip failed: %+v", b)
	}
	agents, _ := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if strings.Contains(string(agents), "secret-token") {
		t.Fatal("token leaked into AGENTS.md")
	}
}

func TestSeedIsIdempotentAndRefreshes(t *testing.T) {
	root := t.TempDir()
	dir, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Seed(root, Binding{ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "two"}); err != nil {
		t.Fatalf("second Seed: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".devdeck/session.json"))
	if !strings.Contains(string(raw), "two") {
		t.Fatal("re-seed did not refresh the token")
	}
}

func TestSlugForThreadIsFilesystemSafe(t *testing.T) {
	if got := SlugForThread("ssh:c-1::chat-2"); strings.ContainsAny(got, ":/\\") {
		t.Fatalf("slug %q is not filesystem-safe", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/sshthread/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write minimal implementation**

Write the assets and `workspace.go`. Keep `AGENTS.md` short (it is read on every session): what this workspace is, that the host is remote and reachable only through `devdeck-ssh`, the command list, and the approval/exit-code rules. Point at `.claude/skills/devops-ssh/SKILL.md` for detail.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/sshthread/ -v && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sshthread/
git commit -m "feat(sshthread): per-thread workspace seeded with agent skill files"
```

---

### Task 9: Wire it into main.go and the agent socket

**Files:**
- Modify: `backend/cmd/server/main.go`
- Modify: `backend/internal/handler/agent_ws.go:245-276` (`autoCreateThread`, `resolveInstanceID`)
- Test: `backend/internal/handler/agent_ws_test.go` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: no new exported API. Wiring only.

Changes, in order:

1. Replace both `approval.NoopBroker{}` uses (`main.go:446` and `main.go:464`) with a single shared `agentGate := approval.NewGate()`.
2. Build `tokenStore := sshtool.NewTokenStore()`, `toolPrompter := &orchestration.ToolApprovalPrompter{Ingestion: agentIngestion, Gate: agentGate}`, a `ShellRunner` adapter closing over `sshFilePool` and calling `sshmgr.RunShell`, a `ThreadPolicy` adapter reading `agentEngine.State().Thread(id).Mode`, and `sshToolSvc := service.NewSSHToolService(...)` + `handler.NewSSHToolHandler(sshToolSvc)`.
3. In `Reactor.InstanceFor`, branch on `orchestration.IsSSHThread(threadID)`:
   - resolve the connection via `st.SSHConnectionByID(...)` (use the store method the SSH handler already uses — check `handler/ssh.go` for its name),
   - `token := tokenStore.Mint(threadID, connectionID)`,
   - `dir, err := sshthread.Seed(filepath.Join(filepath.Dir(*dbPath), "ssh-threads"), sshthread.Binding{...})` with `HubURL` built from the server's own listen address,
   - return the default agent instance (`orchestration.InstanceIDForAgent("")` semantics — reuse the same fallback the worktree branch logs about) and `provider.SessionStartInput{ThreadID: threadID, Cwd: dir}`.
4. Register the five routes from Task 6 inside the **hub-only** block (next to the other `/api/ssh/...` routes), wrapped with `handler.RequireThreadToken(tokenStore)` using the nested-mux pattern at `main.go:727`; add the five paths to `RequireAuth`'s `publicPaths` (`handler/middleware.go:93`) with a comment mirroring the `/api/runtime/catalog` one.
5. In `agent_ws.go`'s `resolveInstanceID`, return the default instance for SSH threads instead of looking up a worktree.

- [ ] **Step 1: Write the failing test**

Append to `agent_ws_test.go`, reusing its existing helpers (`newTestAgentWS`,
`writeJSONFrame`, `readFrame` — see `agent_ws_test.go:71,97,114`):

```go
func TestHelloOnSSHThreadCreatesThreadWithoutAWorktree(t *testing.T) {
	h, _, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	const threadID = "ssh:sc-1" // no worktree with this id exists, and none should be needed
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": threadID, "sinceSeq": 0})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f := readFrame(t, ctx, c)
		if f.Kind == "error" {
			t.Fatalf("hello on an SSH thread returned an error frame: %s", f.Error)
		}
		if len(f.Events) > 0 {
			break
		}
	}
	if _, known := h.engine.State().Thread(threadID); !known {
		t.Fatal("engine does not know the SSH thread after hello")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestHelloOnSSHThread -v`
Expected: FAIL — the handler tries to resolve a worktree and errors.

- [ ] **Step 3: Write minimal implementation**

Make changes 1–5. Keep every worktree code path byte-identical in behaviour.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go vet ./... && go test ./... 2>&1 | tail -20`
Expected: PASS across the whole backend.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go backend/internal/handler/agent_ws.go backend/internal/handler/agent_ws_test.go backend/internal/handler/middleware.go
git commit -m "feat(agent): host SSH chat threads on the hub with tool routes wired"
```

---

### Task 10: Helper CLI

**Files:**
- Create: `backend/cmd/devdeck-ssh/main.go`
- Create: `backend/cmd/devdeck-ssh/client.go`
- Test: `backend/cmd/devdeck-ssh/client_test.go`

**Interfaces:**
- Consumes: the REST contract from Task 6 and `sshthread.Binding`'s JSON shape from Task 8.
- Produces: a binary. Internally: `func loadBinding(dir string) (binding, error)`, `func (c *client) exec(command string) (execResult, int, error)`, plus `read`, `list`, `grep`, `write`.

Commands and exit codes are exactly as the spec's §6 table states. `exec` prints stdout to stdout and stderr to stderr, then exits with the mapped code. Every error message the CLI prints is written for an **agent** to read, e.g. `denied by user: the operator declined "systemctl restart nginx" — stop and ask them what to do instead`.

Read `backend/cmd/mcp-server/main.go` first and follow its structure (flag parsing, `envOr`, `log.Fatalf` style).

- [ ] **Step 1: Write the failing test**

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestExecSendsBearerTokenAndReturnsExitCode(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_ = json.NewEncoder(w).Encode(map[string]any{"stdout": "hi\n", "stderr": "", "exitCode": 7})
	}))
	defer srv.Close()

	c := &client{hubURL: srv.URL, token: "tok-1"}
	res, code, err := c.exec("ls -la")
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if gotAuth != "Bearer tok-1" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"ls -la"`) {
		t.Fatalf("body = %s", gotBody)
	}
	if code != 2 {
		t.Fatalf("cli exit code = %d, want 2 for a non-zero remote exit", code)
	}
	if res.Stdout != "hi\n" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}

func TestExecDeniedMapsTo77(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "denied by user"})
	}))
	defer srv.Close()

	_, code, _ := (&client{hubURL: srv.URL, token: "t"}).exec("rm -rf /")
	if code != 77 {
		t.Fatalf("exit code = %d, want 77", code)
	}
}

func TestLoadBindingReadsSessionFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".devdeck"), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"hubUrl":"http://h","threadId":"ssh:c-1","connectionId":"c-1","token":"tok"}`
	if err := os.WriteFile(filepath.Join(dir, ".devdeck/session.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := loadBinding(dir)
	if err != nil {
		t.Fatalf("loadBinding: %v", err)
	}
	if b.Token != "tok" || b.HubURL != "http://h" {
		t.Fatalf("binding = %+v", b)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./cmd/devdeck-ssh/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `client.go` (transport, error mapping, exit-code mapping) and `main.go` (subcommand dispatch, flag parsing, output).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./cmd/devdeck-ssh/ -v && go build ./... && go vet ./...`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/devdeck-ssh/
git commit -m "feat(cli): devdeck-ssh helper binary for agent-driven remote ops"
```

---

### Task 11: Chat socket target union

**Files:**
- Modify: `frontend/src/features/agent-chat/useAgentChatSocket.ts:88-92,124-140`
- Modify: `frontend/src/features/agent-chat/AgentChatPane.tsx:36-44`
- Modify: every current `<AgentChatPane …>` call site (find them with `grep -rn "AgentChatPane" frontend/src`)
- Test: `frontend/src/features/agent-chat/agentChatTarget.test.ts` (new)

**Interfaces:**
- Produces (exported from `useAgentChatSocket.ts`):

```ts
export type AgentChatTarget =
  | { kind: 'machine'; machine: Machine }
  | { kind: 'hub' }

export function agentChatWsUrl(target: AgentChatTarget): Promise<string>
```

`UseAgentChatSocketOptions.machine` is replaced by `target: AgentChatTarget`. For `kind: 'hub'`, build the URL the way `frontend/src/lib/sshClient.ts:14` does — `window.location.protocol === 'https:' ? 'wss' : 'ws'` plus `window.location.host` plus `/ws/agent`. For `kind: 'machine'`, keep calling `machineWsUrl(machine, AGENT_WS_PATH, {})` unchanged (note the existing `/agent`-not-`/ws/agent` trap documented at `useAgentChatSocket.ts:124`).

`AgentChatPaneProps` gains `target: AgentChatTarget` and makes `worktreeId`, `branch`, `worktreeLabel`, `agentId` optional; existing worktree call sites pass `target={{ kind: 'machine', machine }}`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { agentChatWsUrl } from '@/features/agent-chat/useAgentChatSocket'

describe('agentChatWsUrl', () => {
  it('builds a hub-direct URL from window.location for SSH threads', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'deck.example.com' } as Location)
    await expect(agentChatWsUrl({ kind: 'hub' })).resolves.toBe('wss://deck.example.com/ws/agent')
  })

  it('uses ws:// on a plain-http hub', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' } as Location)
    await expect(agentChatWsUrl({ kind: 'hub' })).resolves.toBe('ws://localhost:5173/ws/agent')
  })
})
```

Add a third case asserting the machine branch still routes through `machineWsUrl` (mock `@/lib/machineClient` and assert it was called with `'/agent'`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/agent-chat/agentChatTarget.test.ts`
Expected: FAIL — `agentChatWsUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

Make the changes above. Keep the existing doc comments; extend rather than replace them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/agent-chat/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/agent-chat/
git commit -m "feat(agent-chat): route the chat socket by target instead of machine"
```

---

### Task 12: SSH rail chat panel

**Files:**
- Create: `frontend/src/features/ssh/SSHAgentChatPanel.tsx`
- Modify: `frontend/src/features/ssh/SSHRightSidebar.tsx:126-155`
- Modify: `frontend/src/store/useDevDeckStore.ts` (widen `SSHRightSidebarPanel`)
- Test: `frontend/src/features/ssh/SSHRightSidebar.test.tsx` (append)

**Interfaces:**
- Consumes: `AgentChatPane` + `AgentChatTarget` from Task 11.
- Produces: `export function SSHAgentChatPanel({ connectionId, visible }: { connectionId: string; visible: boolean })`, rendering `AgentChatPane` with `target={{ kind: 'hub' }}` and `threadKey={`ssh:${connectionId}`}`.

`SSHRightSidebarPanel` becomes `'stats' | 'forwards' | 'chat'`. The rail gains a third `RailButton` (lucide `Bot`, label "DevOps Chat") **above** Stats, and the panel section gains a third hide-not-unmount branch matching the existing two exactly — a chat pane that unmounts would drop its socket on every toggle.

- [ ] **Step 1: Write the failing test**

Append to `SSHRightSidebar.test.tsx`, matching the file's existing render helper:

```tsx
it('opens the chat panel when the DevOps Chat rail button is pressed', async () => {
  renderSidebar() // whatever the existing helper is called
  const button = screen.getByRole('button', { name: 'DevOps Chat' })
  expect(button).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(button)
  expect(button).toHaveAttribute('aria-pressed', 'true')
})

it('keeps the chat panel mounted when switching to Stats', async () => {
  renderSidebar()
  await userEvent.click(screen.getByRole('button', { name: 'DevOps Chat' }))
  const panel = screen.getByTestId('ssh-chat-panel')
  await userEvent.click(screen.getByRole('button', { name: 'Stats' }))
  expect(screen.getByTestId('ssh-chat-panel')).toBe(panel)
})
```

Mock `AgentChatPane` in this test (`vi.mock`) so no WebSocket is opened.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ssh/SSHRightSidebar.test.tsx`
Expected: FAIL — no such button.

- [ ] **Step 3: Write minimal implementation**

Add the panel component, the store union member, the rail button, and the third hidden branch (with `data-testid="ssh-chat-panel"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ssh/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/ssh/ frontend/src/store/useDevDeckStore.ts
git commit -m "feat(ssh): DevOps chat panel in the SSH right rail"
```

---

### Task 13: Remote-file `@` mention source

**Files:**
- Modify: `frontend/src/features/agent-chat/composerMention.ts:122`
- Modify: `frontend/src/features/agent-chat/ComposerPromptEditor.tsx:221,249`
- Modify: `frontend/src/features/agent-chat/ChatComposer.tsx` (thread the source through instead of `machine`/`worktreeId`)
- Test: `frontend/src/features/agent-chat/composerMention.ssh.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface MentionSource {
  /** Returns absolute (SSH) or worktree-relative (worktree) paths. */
  search: (query: string) => Promise<string[]>
}
export function worktreeMentionSource(machine: Machine, worktreeId: string): MentionSource
export function sshMentionSource(connectionId: string): MentionSource
export function createComposerMention(source: MentionSource, debounceMs?: number): ...
```

`sshMentionSource` calls `GET /api/ssh/connections/{id}/files/search?pattern=<q>` (the route already exists, `main.go:754`) and returns the paths verbatim — the inserted mention is the path and nothing else (spec D7). `worktreeMentionSource` wraps today's behaviour with no change in what it fetches.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sshMentionSource } from '@/features/agent-chat/composerMention'

describe('sshMentionSource', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ['/home/clouduser/deployment-web-internal.yml'],
    })))
  })

  it('queries the SSH file search route and returns paths unchanged', async () => {
    const paths = await sshMentionSource('c-1').search('deploy')
    expect(paths).toEqual(['/home/clouduser/deployment-web-internal.yml'])
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('/api/ssh/connections/c-1/files/search')
    expect(url).toContain('pattern=deploy')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/agent-chat/composerMention.ssh.test.ts`
Expected: FAIL — `sshMentionSource` is not exported.

- [ ] **Step 3: Write minimal implementation**

Introduce `MentionSource`, both factories, and change `createComposerMention` to take a source. Update `ComposerPromptEditor` and `ChatComposer` to accept and forward a `mentionSource` prop, defaulting to the worktree source when a machine + worktree id are present (so `ChatComposer.test.tsx`'s `NO_MACHINE` mounts keep working). `SSHAgentChatPanel`'s pane passes `sshMentionSource(connectionId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/agent-chat/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/agent-chat/ frontend/src/features/ssh/
git commit -m "feat(agent-chat): remote-file mention source for SSH threads"
```

---

## Verification (after Task 13)

```bash
cd backend && go vet ./... && go test ./... && go build ./...
cd ../frontend && npm run typecheck && npm test
```

`npm test` is expected to report exactly one pre-existing Monaco guard failure and nothing else.
