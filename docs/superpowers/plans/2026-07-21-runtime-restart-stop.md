# Runtime Restart/Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Restart and Stop controls to the Runtimes page so an operator can control a registered machine's actual process, not just its registry entry.

**Architecture:** Every DevDeck process gets two new self-management HTTP endpoints (`POST /api/self/restart`, `POST /api/self/stop`). The hub exposes `POST /api/machines/{id}/restart|stop`, which looks up the machine and calls its own self-endpoint over HTTP with its stored key — the same code path handles the local machine too, since its stored URL is a loopback address back to itself. A new `--managed` flag (always set by the Tauri desktop when it spawns a sidecar) tells a process "something else already owns your respawn lifecycle," so it skips self-spawning on restart (avoiding a second, colliding respawn) and refuses to stop (avoiding silent self-resurrection).

**Tech Stack:** Go (`net/http`, `os/exec`, stdlib `testing`), Rust (Tauri sidecar arg-building, already-used `#[cfg(test)]` unit tests), React + TanStack Query + Zustand (existing patterns in `queries.ts`/`useDevDeckStore.ts`).

## Global Constraints

- Go: module path `devdeck/backend`, packages under `devdeck/backend/internal/`; `writeJSON`/`writeErr`/`handleStoreErr` from `backend/internal/handler/middleware.go` for all handler responses; run `go vet ./...` before considering a Go task done.
- Frontend: `@/*` path alias only, never relative imports into `src/`; `import type` for type-only imports (`verbatimModuleSyntax`); mutations invalidate query cache on success and show a toast + resync on failure; icons from `lucide-react` only; run `npm run typecheck` before considering a frontend task done.
- Rust: `frontend/src-tauri/src/sidecar.rs` build args as `Vec<String>`; existing tests in that file assert presence/absence of specific flag strings via `args.join(" ")` — new tests must follow that exact style.
- Every new Go handler/client function gets a doc comment in the existing style of the file it lives in (present in every file read during design: full sentences, explains *why* not just *what*).

---

### Task 1: `SelfHandler` — restart/stop endpoints on every DevDeck process

**Files:**
- Create: `backend/internal/handler/self.go`
- Create: `backend/internal/handler/self_unix.go`
- Create: `backend/internal/handler/self_windows.go`
- Create: `backend/internal/handler/self_test.go`

**Interfaces:**
- Produces: `handler.NewSelfHandler(managed bool) *SelfHandler`, `(*SelfHandler).PostRestart(w http.ResponseWriter, r *http.Request)`, `(*SelfHandler).PostStop(w http.ResponseWriter, r *http.Request)` — Task 2 registers these as routes.
- Consumes: `writeJSON`/`writeErr` from `backend/internal/handler/middleware.go` (already in package `handler`, no import needed).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/handler/self_test.go`:

```go
package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stubSpawnReplacement replaces the package-level spawnReplacement for the
// duration of a test, returning a pointer the test can check afterward to
// see whether it was called.
func stubSpawnReplacement(t *testing.T, err error) *bool {
	t.Helper()
	called := false
	orig := spawnReplacement
	spawnReplacement = func() error {
		called = true
		return err
	}
	t.Cleanup(func() { spawnReplacement = orig })
	return &called
}

// stubExitProcess replaces the package-level exitProcess so tests never
// actually call os.Exit; the returned channel receives a value each time
// the stub runs.
func stubExitProcess(t *testing.T) <-chan struct{} {
	t.Helper()
	done := make(chan struct{}, 1)
	orig := exitProcess
	exitProcess = func() { done <- struct{}{} }
	t.Cleanup(func() { exitProcess = orig })
	return done
}

func waitForExit(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("exitProcess was not called within 1s")
	}
}

func assertExitNotCalled(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Error("exitProcess must not be called")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPostRestartUnmanagedSpawnsReplacementThenExits(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !*called {
		t.Error("PostRestart on an unmanaged process must spawn a replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartManagedDoesNotSpawnReplacement(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(true)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if *called {
		t.Error("PostRestart on a managed process must not spawn its own replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartUnmanagedSpawnFailureReturns500AndDoesNotExit(t *testing.T) {
	stubSpawnReplacement(t, errors.New("boom"))
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}

func TestPostStopUnmanagedExits(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(false)
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	waitForExit(t, done)
}

func TestPostStopManagedRefuses(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(true)
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestPostRestart -run TestPostStop -v`
Expected: FAIL to compile — `NewSelfHandler`, `spawnReplacement`, `exitProcess` undefined.

- [ ] **Step 3: Create the platform-specific detach helpers**

Create `backend/internal/handler/self_unix.go`:

```go
//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package handler

import (
	"os/exec"
	"syscall"
)

// detachFromParent starts the replacement process in its own session, so it
// survives this process exiting instead of dying with its process group
// (mirrors terminal/process_unix.go's PTY child session handling).
func detachFromParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
```

Create `backend/internal/handler/self_windows.go`:

```go
//go:build windows

package handler

import (
	"os/exec"
	"syscall"
)

// detachFromParent starts the replacement process in its own process
// group, so it survives this process exiting.
func detachFromParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}
```

- [ ] **Step 4: Write the minimal implementation**

Create `backend/internal/handler/self.go`:

```go
package handler

import (
	"net/http"
	"os"
	"os/exec"
	"time"
)

// SelfHandler exposes this process's own restart/stop lifecycle over HTTP,
// so the hub's Runtimes page can control a registered machine's process
// directly instead of the operator doing it by hand on that machine. See
// docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md.
type SelfHandler struct {
	// managed is true when an external supervisor (the Tauri desktop's
	// sidecar respawn loop) already owns this process's respawn lifecycle
	// — set via --managed/DEVDECK_MANAGED. A managed process must never
	// spawn its own replacement (the supervisor would end up spawning a
	// second one too), and must refuse to stop (the supervisor would just
	// silently relaunch it, which is worse than a clear error).
	managed bool
}

// NewSelfHandler creates a self-management handler.
func NewSelfHandler(managed bool) *SelfHandler {
	return &SelfHandler{managed: managed}
}

// spawnReplacement and exitProcess are swappable package-level vars so
// tests can assert what PostRestart/PostStop *would* do without actually
// spawning a child process or exiting the test binary.
var (
	spawnReplacement = defaultSpawnReplacement
	exitProcess      = defaultExitProcess
)

// defaultSpawnReplacement re-execs this binary: same executable path, same
// argv, detached so it outlives this process's exit. Used only when this
// process is unmanaged — a managed process relies on its supervisor to
// relaunch it instead (see SelfHandler.managed).
func defaultSpawnReplacement() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	detachFromParent(cmd)
	return cmd.Start()
}

// defaultExitProcess exits after a short delay so the HTTP response that
// triggered it has time to actually flush to the client first.
func defaultExitProcess() {
	time.Sleep(300 * time.Millisecond)
	os.Exit(0)
}

// PostRestart handles POST /api/self/restart. An unmanaged process spawns a
// detached copy of itself (same executable, same args) before exiting, so
// it comes back on its own with no external supervisor required. A managed
// process just exits — its supervisor already handles respawning it, and
// spawning a second replacement here would race that supervisor's own.
func (h *SelfHandler) PostRestart(w http.ResponseWriter, r *http.Request) {
	if !h.managed {
		if err := spawnReplacement(); err != nil {
			writeErr(w, http.StatusInternalServerError, "spawn replacement process: "+err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
	go exitProcess()
}

// PostStop handles POST /api/self/stop. An unmanaged process exits and
// stays down. A managed process refuses: its supervisor would silently
// relaunch it a moment later, which is worse than a clear error telling
// the operator why "stop" didn't stick.
func (h *SelfHandler) PostStop(w http.ResponseWriter, r *http.Request) {
	if h.managed {
		writeErr(w, http.StatusConflict, "this runtime is supervised by its desktop app and can't be stopped from here")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopping"})
	go exitProcess()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -run 'TestPostRestart|TestPostStop' -v`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Run go vet**

Run: `cd backend && go vet ./internal/handler/...`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/self.go backend/internal/handler/self_unix.go backend/internal/handler/self_windows.go backend/internal/handler/self_test.go
git commit -m "feat(runtime): add /api/self/restart and /api/self/stop"
```

---

### Task 2: Wire `--managed` flag and self routes into `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `handler.NewSelfHandler(managed bool) *SelfHandler` (Task 1), `envBool(key string, fallback bool) bool` (already in `main.go`).
- Produces: `POST /api/self/restart`, `POST /api/self/stop` routes, live for every `--role`.

- [ ] **Step 1: Add the `--managed` flag**

In `backend/cmd/server/main.go`, find this line (around line 60):

```go
	tailscaleServe := flag.Bool("enable-tailscale-serve", envBool("DEVDECK_TAILSCALE_SERVE", false), "expose the server on your tailnet by running `tailscale serve <port>` alongside it (requires the tailscale CLI)")
```

Add immediately after it:

```go
	managed := flag.Bool("managed", envBool("DEVDECK_MANAGED", false), "mark this process as supervised by an external respawn loop (set by the Tauri desktop sidecar) — /api/self/restart won't spawn its own replacement, and /api/self/stop will refuse, since the supervisor already owns this process's respawn lifecycle")
```

- [ ] **Step 2: Construct the handler and register routes**

Find this line (around line 244):

```go
	tailscaleStatusH := handler.NewTailscaleStatusHandler(*tailscaleServe)
```

Add immediately after it:

```go
	selfH := handler.NewSelfHandler(*managed)
```

Find this line (around line 336):

```go
	mux.HandleFunc("GET /api/tailscale-status", tailscaleStatusH.ServeHTTP)
```

Add immediately after it:

```go
	mux.HandleFunc("POST /api/self/restart", selfH.PostRestart)
	mux.HandleFunc("POST /api/self/stop", selfH.PostStop)
```

(These go outside any `if !isRuntime` block — every role, including a pure `--role runtime`, must be able to restart/stop itself.)

- [ ] **Step 3: Build to verify it compiles**

Run: `cd backend && go build ./...`
Expected: no output, exit 0.

- [ ] **Step 4: Run go vet**

Run: `cd backend && go vet ./...`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(runtime): wire --managed flag and self routes into main.go"
```

---

### Task 3: `machineclient.Restart`/`Stop`

**Files:**
- Modify: `backend/internal/machineclient/client.go`
- Modify: `backend/internal/machineclient/client_test.go`

**Interfaces:**
- Consumes: `domain.Machine{ID, URL, Key}` (existing type).
- Produces: `machineclient.Restart(ctx context.Context, m domain.Machine) error`, `machineclient.Stop(ctx context.Context, m domain.Machine) error` — Task 4 calls these.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/machineclient/client_test.go` (append at the end of the file):

```go
func TestRestartSucceedsAndPostsToSelfRestart(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Restart(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"}); err != nil {
		t.Fatalf("Restart() error = %v, want nil", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/self/restart" || gotAuth != "Bearer k" {
		t.Errorf("got method=%s path=%s auth=%s, want POST /api/self/restart with Bearer k", gotMethod, gotPath, gotAuth)
	}
}

func TestRestartFailsOnUnreachable(t *testing.T) {
	err := Restart(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if err == nil {
		t.Fatal("Restart() error = nil, want an unreachable error")
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error = %q, want it to mention unreachable", err.Error())
	}
}

func TestStopSucceedsAndPostsToSelfStop(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Stop(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"}); err != nil {
		t.Fatalf("Stop() error = %v, want nil", err)
	}
	if gotPath != "/api/self/stop" {
		t.Errorf("path = %q, want /api/self/stop", gotPath)
	}
}

func TestStopSurfacesTheTargetsErrorMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"this runtime is supervised by its desktop app and can't be stopped from here"}`))
	}))
	t.Cleanup(srv.Close)

	err := Stop(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if err == nil {
		t.Fatal("Stop() error = nil, want the target's refusal surfaced")
	}
	if !strings.Contains(err.Error(), "supervised by its desktop app") {
		t.Errorf("error = %q, want it to surface the target's own error message", err.Error())
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/... -run 'TestRestart|TestStop' -v`
Expected: FAIL to compile — `Restart`/`Stop` undefined.

- [ ] **Step 3: Write the minimal implementation**

In `backend/internal/machineclient/client.go`, add `"io"` to the import block (it currently reads):

```go
import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
)
```

Change to:

```go
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
)
```

Append to the end of `backend/internal/machineclient/client.go`:

```go

// Restart tells m's runtime process to restart itself via its own
// /api/self/restart endpoint. The call completes as soon as the target
// accepts the request (200) — it does not wait for the target to actually
// come back up; callers that care about that poll CheckHealth afterward,
// same as any other machine state change.
func Restart(ctx context.Context, m domain.Machine) error {
	return postSelf(ctx, m, "restart")
}

// Stop tells m's runtime process to stop. See Restart for the "call
// completes on acceptance, not on completion" note.
func Stop(ctx context.Context, m domain.Machine) error {
	return postSelf(ctx, m, "stop")
}

func postSelf(ctx context.Context, m domain.Machine, action string) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	url := strings.TrimRight(m.URL, "/") + "/api/self/" + action
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		msg := extractErrorMessage(body, resp.StatusCode)
		return fmt.Errorf("machine %s: %s", m.ID, msg)
	}
	return nil
}

// extractErrorMessage unwraps the {"error":"..."} envelope every DevDeck
// handler uses, so callers see the target's actual reason (e.g. "supervised
// by its desktop app...") instead of a raw status code or JSON blob.
func extractErrorMessage(body []byte, status int) string {
	var envelope struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error != "" {
		return envelope.Error
	}
	return fmt.Sprintf("returned status %d", status)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/... -v`
Expected: PASS — all tests in the package green, including the new ones.

- [ ] **Step 5: Run go vet**

Run: `cd backend && go vet ./internal/machineclient/...`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/machineclient/client.go backend/internal/machineclient/client_test.go
git commit -m "feat(runtime): add machineclient.Restart/Stop"
```

---

### Task 4: `MachineHandler` restart/stop routes

**Files:**
- Modify: `backend/internal/handler/machine.go`
- Modify: `backend/internal/handler/machine_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `machineclient.Restart`/`Stop` (Task 3), `h.st.MachineByID(id) (domain.Machine, error)` (existing), `handleStoreErr`/`writeErr`/`writeJSON` (existing).
- Produces: `(*MachineHandler).PostMachineRestart`, `(*MachineHandler).PostMachineStop` — Task 2's route wiring pattern extends to these; Task 9 (frontend) calls `POST /api/machines/{id}/restart` and `POST /api/machines/{id}/stop`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/handler/machine_test.go`:

```go
func TestPostMachineRestartCallsTheMachinesSelfRestart(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/restart", h.PostMachineRestart)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/restart" {
		t.Errorf("backend received path %q, want /api/self/restart", gotPath)
	}
}

func TestPostMachineRestartSurfacesUnreachable(t *testing.T) {
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("dead", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/restart", h.PostMachineRestart)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/restart", nil))

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 for an unreachable machine", rec.Code)
	}
}

func TestPostMachineStopCallsTheMachinesSelfStop(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/stop", h.PostMachineStop)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/stop", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/stop" {
		t.Errorf("backend received path %q, want /api/self/stop", gotPath)
	}
}

func TestPostMachineStopRefusesForLocalMachine(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("must not call the local machine's /api/self/stop at all")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("desktop", backend.URL, "k", true)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/stop", h.PostMachineStop)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/stop", nil))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for stopping the local machine", rec.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestPostMachineRestart -run TestPostMachineStop -v`
Expected: FAIL to compile — `PostMachineRestart`/`PostMachineStop` undefined.

- [ ] **Step 3: Write the minimal implementation**

In `backend/internal/handler/machine.go`, append these two methods at the end of the file (after `healthResponse`):

```go

// PostMachineRestart handles POST /api/machines/{id}/restart: tells the
// target machine's own process to restart itself. Works for the local
// machine too — its stored URL is its own http://127.0.0.1:<port>, so this
// is a loopback call back into this exact process. See machineclient.Restart.
func (h *MachineHandler) PostMachineRestart(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	if err := machineclient.Restart(r.Context(), m); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
}

// PostMachineStop handles POST /api/machines/{id}/stop: tells the target
// machine's own process to stop. Refused for the local machine — the Tauri
// desktop's respawn loop would just relaunch it, so there is no "stopped"
// state to reach for that row (see design doc, Decision 3).
func (h *MachineHandler) PostMachineStop(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	if m.IsLocal {
		writeErr(w, http.StatusBadRequest, "the local machine can't be stopped from here")
		return
	}
	if err := machineclient.Stop(r.Context(), m); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopping"})
}
```

- [ ] **Step 4: Register the routes in `main.go`**

In `backend/cmd/server/main.go`, find (around line 456, inside the `if !isRuntime { ... }` block):

```go
		mux.HandleFunc("GET /api/machines/{id}/health", machineH.GetMachineHealth)
		mux.HandleFunc("POST /api/machines/{id}/token", machineH.PostToken)
```

Add immediately after it:

```go
		mux.HandleFunc("POST /api/machines/{id}/restart", machineH.PostMachineRestart)
		mux.HandleFunc("POST /api/machines/{id}/stop", machineH.PostMachineStop)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS — every test in the package green, including the 4 new ones.

- [ ] **Step 6: Build and vet the whole backend**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/machine.go backend/internal/handler/machine_test.go backend/cmd/server/main.go
git commit -m "feat(runtime): add POST /api/machines/{id}/restart|stop"
```

---

### Task 5: `--managed` flag on the Tauri-spawned sidecar and background runtime

**Files:**
- Modify: `frontend/src-tauri/src/sidecar.rs`

**Interfaces:**
- Produces: `sidecar_args(...)` and `runtime_args(...)` both include `"--managed"` in their returned `Vec<String>` — no signature change, existing callers in `lib.rs` (`launch_once`, `launch_runtime_once`) need no changes.

- [ ] **Step 1: Write the failing test assertions**

In `frontend/src-tauri/src/sidecar.rs`, find the `args_carry_the_desktop_contract` test:

```rust
    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false);
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("devdeck.db"));
        assert!(!joined.contains("--enable-tailscale-serve"));
    }
```

Replace with:

```rust
    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false);
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("devdeck.db"));
        assert!(joined.contains("--managed"));
        assert!(!joined.contains("--enable-tailscale-serve"));
    }
```

Find the `runtime_args_carry_the_remote_contract` test:

```rust
    #[test]
    fn runtime_args_carry_the_remote_contract() {
        let args = runtime_args(
            Path::new("/data"),
            "k0",
            "https://hub.example",
            "hk0",
            "https://me.ts.net",
            "my-mac",
        );
        let joined = args.join(" ");
        assert!(joined.contains("--role runtime"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--hub-url https://hub.example"));
        assert!(joined.contains("--hub-key hk0"));
        assert!(joined.contains("--public-url https://me.ts.net"));
        assert!(joined.contains("--name my-mac"));
        assert!(joined.contains("--enable-tailscale-serve"));
        assert!(joined.contains("devdeck-runtime.db"));
    }
```

Replace with:

```rust
    #[test]
    fn runtime_args_carry_the_remote_contract() {
        let args = runtime_args(
            Path::new("/data"),
            "k0",
            "https://hub.example",
            "hk0",
            "https://me.ts.net",
            "my-mac",
        );
        let joined = args.join(" ");
        assert!(joined.contains("--role runtime"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--hub-url https://hub.example"));
        assert!(joined.contains("--hub-key hk0"));
        assert!(joined.contains("--public-url https://me.ts.net"));
        assert!(joined.contains("--name my-mac"));
        assert!(joined.contains("--enable-tailscale-serve"));
        assert!(joined.contains("--managed"));
        assert!(joined.contains("devdeck-runtime.db"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/src-tauri && cargo test --lib sidecar`
Expected: FAIL — both edited assertions (`joined.contains("--managed")`) fail since the flag isn't emitted yet.

- [ ] **Step 3: Write the minimal implementation**

Find `sidecar_args`:

```rust
pub fn sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
    ];
    if enable_tailscale_serve {
        args.push("--enable-tailscale-serve".into());
    }
    args
}
```

Replace with:

```rust
pub fn sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
        // Tells the Go process an external supervisor (this Tauri app's own
        // respawn loop) already owns its respawn lifecycle — see
        // docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md.
        "--managed".into(),
    ];
    if enable_tailscale_serve {
        args.push("--enable-tailscale-serve".into());
    }
    args
}
```

Find `runtime_args`:

```rust
pub fn runtime_args(
    data_dir: &Path,
    key: &str,
    hub_url: &str,
    hub_key: &str,
    public_url: &str,
    name: &str,
) -> Vec<String> {
    vec![
        "--role".into(), "runtime".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck-runtime.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--hub-url".into(), hub_url.into(),
        "--hub-key".into(), hub_key.into(),
        "--public-url".into(), public_url.into(),
        "--name".into(), name.into(),
        "--enable-tailscale-serve".into(),
    ]
}
```

Replace with:

```rust
pub fn runtime_args(
    data_dir: &Path,
    key: &str,
    hub_url: &str,
    hub_key: &str,
    public_url: &str,
    name: &str,
) -> Vec<String> {
    vec![
        "--role".into(), "runtime".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("devdeck-runtime.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--hub-url".into(), hub_url.into(),
        "--hub-key".into(), hub_key.into(),
        "--public-url".into(), public_url.into(),
        "--name".into(), name.into(),
        "--enable-tailscale-serve".into(),
        // See sidecar_args's --managed comment — same reasoning applies to
        // this desktop's background remote-mode runtime.
        "--managed".into(),
    ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/src-tauri && cargo test --lib sidecar`
Expected: PASS — all `sidecar::tests::*` green.

- [ ] **Step 5: Run the full Rust test suite and build**

Run: `cd frontend/src-tauri && cargo build --lib && cargo test --lib`
Expected: build succeeds, all tests pass (should be 20 existing + 0 new test functions, 2 modified).

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/src/sidecar.rs
git commit -m "feat(runtime): pass --managed to Tauri-spawned sidecar and background runtime"
```

---

### Task 6: Frontend API functions and mutations

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: `request<T>(method, path, body?, opts?)` (existing, in `api.ts`), `qk.machines`, `qk.machineHealth(id)` (existing, in `features/data/keys.ts`).
- Produces: `restartMachine(id: string): Promise<void>`, `stopMachine(id: string): Promise<void>` (`api.ts`); `useRestartMachine()`, `useStopMachine()` (`queries.ts`, both `UseMutationResult<void, unknown, string>`) — Task 8's dialog component calls these.

- [ ] **Step 1: Add the API functions**

In `frontend/src/lib/api.ts`, find:

```ts
export function deleteMachine(id: string): Promise<void> {
  return request<void>('DELETE', `/machines/${id}`)
}
```

Add immediately after it:

```ts
export function restartMachine(id: string): Promise<void> {
  return request<void>('POST', `/machines/${id}/restart`)
}

export function stopMachine(id: string): Promise<void> {
  return request<void>('POST', `/machines/${id}/stop`)
}
```

- [ ] **Step 2: Add the mutations**

In `frontend/src/features/data/queries.ts`, add `restartMachine` and `stopMachine` to the import from `@/lib/api`. Find:

```ts
  mintHandoverToken,
  seed,
```

Replace with:

```ts
  mintHandoverToken,
  restartMachine,
  seed,
```

Find:

```ts
  setDBSecret,
  testDBConnection,
```

Replace with:

```ts
  setDBSecret,
  stopMachine,
  testDBConnection,
```

Find `useDeleteMachine`:

```ts
export function useDeleteMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteMachine(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
  })
}
```

Add immediately after it:

```ts
export function useRestartMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => restartMachine(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: qk.machines })
      queryClient.invalidateQueries({ queryKey: qk.machineHealth(id) })
    },
  })
}

export function useStopMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => stopMachine(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: qk.machines })
      queryClient.invalidateQueries({ queryKey: qk.machineHealth(id) })
    },
  })
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/queries.ts
git commit -m "feat(runtime): add restartMachine/stopMachine API functions and mutations"
```

---

### Task 7: Store slice for the confirm dialog

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts`

**Interfaces:**
- Produces: exported type `MachineAction = 'restart' | 'stop'`; state field `confirmMachineAction: { action: MachineAction; id: string; name: string } | null`; actions `askMachineAction: (action: MachineAction, id: string, name: string) => void`, `cancelMachineAction: () => void` — Task 8's dialog component reads/calls these.

- [ ] **Step 1: Add the exported type**

Find (near the top of the file):

```ts
export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh' | 'ssh-group'
```

Add immediately after it:

```ts
export type MachineAction = 'restart' | 'stop'
```

- [ ] **Step 2: Add the state field to the store interface**

Find:

```ts
  confirmDelete: { kind: EditKind; id: string; name: string } | null
```

Add immediately after it:

```ts
  confirmMachineAction: { action: MachineAction; id: string; name: string } | null
```

- [ ] **Step 3: Add the action signatures to the store interface**

Find:

```ts
  askDelete: (kind: EditKind, id: string, name: string) => void
  cancelConfirm: () => void
```

Add immediately after it:

```ts
  askMachineAction: (action: MachineAction, id: string, name: string) => void
  cancelMachineAction: () => void
```

- [ ] **Step 4: Add the initial state value**

Find:

```ts
      confirmDelete: null,
```

Add immediately after it:

```ts
      confirmMachineAction: null,
```

- [ ] **Step 5: Implement the actions**

Find:

```ts
      askDelete: (kind, id, name) => set((s) => void (s.confirmDelete = { kind, id, name })),
      cancelConfirm: () => set((s) => void (s.confirmDelete = null)),
```

Add immediately after it:

```ts
      askMachineAction: (action, id, name) => set((s) => void (s.confirmMachineAction = { action, id, name })),
      cancelMachineAction: () => set((s) => void (s.confirmMachineAction = null)),
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts
git commit -m "feat(runtime): add confirmMachineAction store slice"
```

---

### Task 8: `ConfirmMachineActionDialog` component

**Files:**
- Create: `frontend/src/features/overlays/ConfirmMachineActionDialog.tsx`
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx`

**Interfaces:**
- Consumes: `useDevDeckStore` state/actions from Task 7 (`confirmMachineAction`, `cancelMachineAction`, `askMachineAction` — the last used by Task 9), `useRestartMachine`/`useStopMachine` from Task 6, `showToast` (existing store action).
- Produces: `<ConfirmMachineActionDialog />`, rendered from `GlobalOverlays`.

- [ ] **Step 1: Create the component**

Create `frontend/src/features/overlays/ConfirmMachineActionDialog.tsx`:

```tsx
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useRestartMachine, useStopMachine } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const COPY = {
  restart: {
    title: 'Restart runtime',
    body: (name: string) =>
      `This restarts the runtime process on "${name}". Active terminals on this machine will disconnect and reconnect once it's back — usually a few seconds.`,
    confirmLabel: 'Restart',
    iconClassName: 'text-devdeck-yellow-soft',
    confirmVariant: 'warning' as const,
  },
  stop: {
    title: 'Stop runtime',
    body: (name: string) =>
      `This stops the runtime process on "${name}". It will not come back on its own — you'll need to relaunch it manually on that machine.`,
    confirmLabel: 'Stop',
    iconClassName: 'text-devdeck-red-soft',
    confirmVariant: 'destructive-solid' as const,
  },
}

export function ConfirmMachineActionDialog() {
  const confirm = useDevDeckStore((s) => s.confirmMachineAction)
  const cancel = useDevDeckStore((s) => s.cancelMachineAction)
  const showToast = useDevDeckStore((s) => s.showToast)
  const restartMachine = useRestartMachine()
  const stopMachine = useStopMachine()

  const open = !!confirm
  const pending = restartMachine.isPending || stopMachine.isPending
  const copy = confirm ? COPY[confirm.action] : null

  function onConfirm() {
    if (!confirm) return
    const { action, id, name } = confirm
    const mutation = action === 'restart' ? restartMachine : stopMachine
    mutation.mutate(id, {
      onSuccess: () => {
        cancel()
        showToast(`${action === 'restart' ? 'Restarting' : 'Stopping'} "${name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : `Failed to ${action} "${name}"`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && cancel()} width={400} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className={copy?.iconClassName} />
        <DialogTitle>{copy?.title ?? ''}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        {confirm && copy ? copy.body(confirm.name) : ''}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={cancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant={copy?.confirmVariant ?? 'default'} onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 size={14} className="animate-spin" />}
          {copy?.confirmLabel ?? ''}
        </Button>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 2: Register it in `GlobalOverlays`**

In `frontend/src/features/overlays/GlobalOverlays.tsx`, find:

```tsx
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
```

Add immediately after it:

```tsx
import { ConfirmMachineActionDialog } from './ConfirmMachineActionDialog'
```

Find:

```tsx
      <ConfirmDeleteDialog />
```

Add immediately after it:

```tsx
      <ConfirmMachineActionDialog />
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/overlays/ConfirmMachineActionDialog.tsx frontend/src/features/overlays/GlobalOverlays.tsx
git commit -m "feat(runtime): add ConfirmMachineActionDialog"
```

---

### Task 9: Restart/Stop buttons on `MachineRow`

**Files:**
- Modify: `frontend/src/features/machines/MachinesModule.tsx`

**Interfaces:**
- Consumes: `askMachineAction` from Task 7's store slice.

- [ ] **Step 1: Add the icon imports**

Find:

```tsx
import { Monitor, Plus, Server, Settings2, Trash2 } from 'lucide-react'
```

Replace with:

```tsx
import { Monitor, Plus, Power, RotateCw, Server, Settings2, Trash2 } from 'lucide-react'
```

- [ ] **Step 2: Rewrite `MachineRow`'s action area**

Find the full `MachineRow` function:

```tsx
function MachineRow({ machine }: { machine: Machine }) {
  const openEditMachine = useDevDeckStore((s) => s.openEditMachine)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  return (
    <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[12px] border border-devdeck-border-card bg-devdeck-card px-3 py-2.5 transition-colors hover:border-devdeck-border-accent lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-devdeck-surface-2 text-devdeck-muted">
        {machine.isLocal ? <Monitor size={15} /> : <Server size={15} />}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13px] font-semibold text-devdeck-fg-2">{machine.name}</div>
          {machine.isLocal ? (
            <span className="flex-none rounded-md border border-devdeck-border-card bg-devdeck-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-dim-2">
              local
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-devdeck-dim-2">{machine.url}</div>
      </div>

      <div className="col-span-2 flex items-center gap-2 pl-12 lg:col-span-1 lg:pl-0">
        <RuntimeHealth machineId={machine.id} />
        <div className="min-w-2 flex-1 lg:hidden" />
        {machine.isLocal ? (
          <span className="ml-auto rounded-md bg-devdeck-surface-2 px-2 py-1 font-mono text-[10px] text-devdeck-dim-2 lg:ml-0">
            managed
          </span>
        ) : (
          <div className="ml-auto flex items-center gap-1 lg:ml-0">
            <button
              type="button"
              aria-label={`Edit ${machine.name}`}
              onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Settings2 size={13} />
            </button>
            <button
              type="button"
              aria-label={`Delete ${machine.name}`}
              onClick={() => askDelete('machine', machine.id, machine.name)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
```

Replace with:

```tsx
function MachineRow({ machine }: { machine: Machine }) {
  const openEditMachine = useDevDeckStore((s) => s.openEditMachine)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const askMachineAction = useDevDeckStore((s) => s.askMachineAction)
  return (
    <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[12px] border border-devdeck-border-card bg-devdeck-card px-3 py-2.5 transition-colors hover:border-devdeck-border-accent lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-devdeck-surface-2 text-devdeck-muted">
        {machine.isLocal ? <Monitor size={15} /> : <Server size={15} />}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13px] font-semibold text-devdeck-fg-2">{machine.name}</div>
          {machine.isLocal ? (
            <span className="flex-none rounded-md border border-devdeck-border-card bg-devdeck-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-dim-2">
              local
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-devdeck-dim-2">{machine.url}</div>
      </div>

      <div className="col-span-2 flex items-center gap-2 pl-12 lg:col-span-1 lg:pl-0">
        <RuntimeHealth machineId={machine.id} />
        <div className="min-w-2 flex-1 lg:hidden" />
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          {machine.isLocal ? (
            <span className="rounded-md bg-devdeck-surface-2 px-2 py-1 font-mono text-[10px] text-devdeck-dim-2">
              managed
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`Restart ${machine.name}`}
            onClick={() => askMachineAction('restart', machine.id, machine.name)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RotateCw size={13} />
          </button>
          {machine.isLocal ? null : (
            <>
              <button
                type="button"
                aria-label={`Stop ${machine.name}`}
                onClick={() => askMachineAction('stop', machine.id, machine.name)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Power size={13} />
              </button>
              <button
                type="button"
                aria-label={`Edit ${machine.name}`}
                onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Settings2 size={13} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${machine.name}`}
                onClick={() => askDelete('machine', machine.id, machine.name)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/machines/MachinesModule.tsx
git commit -m "feat(runtime): add Restart/Stop buttons to the Runtimes page"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full Go build, vet, and test**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build succeeds; vet is silent; every package reports `ok` (or `[no test files]` for packages that never had tests, e.g. `cmd/server`).

- [ ] **Step 2: Full Rust build and test**

Run: `cd frontend/src-tauri && cargo build --lib && cargo test --lib`
Expected: build succeeds; all tests pass (20 pre-existing + the 2 edited assertions in `sidecar::tests`).

- [ ] **Step 3: Frontend typecheck and full build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: no type errors; build completes.

- [ ] **Step 4: Manual smoke test**

Run: `make dev-tauri-full`

In the opened window: go to the Runtimes page. Confirm:
- The local row shows a Restart button (no Stop button).
- Click Restart on the local row → confirm dialog appears with the restart copy → confirm → toast appears, health badge briefly goes offline then back online within ~15s.
- Add a second machine (or use an existing remote one if available) → confirm it shows Restart, Stop, Edit, and Delete buttons.
- Click Stop on a remote (or scripted) runtime → confirm dialog appears with the stop copy → confirm → toast appears, health badge goes offline and stays offline (no auto-recovery).

- [ ] **Step 5: Final commit if anything was fixed during manual smoke testing**

```bash
git add -A
git commit -m "fix(runtime): address issues found in manual smoke testing"
```

(Skip this step if the manual smoke test found nothing to fix.)
