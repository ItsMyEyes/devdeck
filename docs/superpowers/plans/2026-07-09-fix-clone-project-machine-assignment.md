# Fix: Cloning a Project Drops Its Machine Assignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloning a project via "Clone from GitHub" onto a registered runtime machine must actually clone the repo on that machine and persist its `machineId` — today it silently drops the machine assignment and always clones onto the hub's own filesystem.

**Architecture:** `ProjectService.Clone` gains a `machineID` parameter. When empty (today's only case), behavior is 100% unchanged — clone happens locally on the hub. When non-empty, the hub forwards the clone to the target machine via a new `machineclient.CloneOnMachine` call (mirroring the existing `machineclient.FetchWorktrees` hub→runtime pattern) against a new runtime-side `POST /api/fs/clone` endpoint, then records the project with the correct `machineId`.

**Tech Stack:** Go 1.22+ stdlib `net/http`/`net/http/httptest`, existing `machineclient` package, existing `git`/`gitpkg` package (`backend/internal/git/git.go`).

## Root cause (confirmed via live reproduction against a real hub+runtime pair)

- `backend/internal/handler/project.go`'s `PostCloneProject` request-body struct has no `MachineID` field at all — it's never decoded, even though the frontend (`frontend/src/features/overlays/NewProjectDialog.tsx:71`) already sends `machineId` in the clone request body today.
- `backend/internal/service/project.go`'s `Clone` hardcodes `svc.store.CreateProject(wsID, name, path, repo, "")` — the trailing `""` — so every cloned project ends up unassigned (`machineId: ""`) regardless of what was requested.
- `Clone`'s actual `git clone` runs via plain local `os.Stat`/`gitpkg.Clone` calls — it always executes wherever the hub process itself runs, never on a selected remote machine.
- Effect in the browser: `machineId` comes back `""`, so `SpawnDialog.tsx:30` / `ExpandedTerminal.tsx:136`'s `machines.find(m => m.id === project.machineId)` can never match (no machine has an empty id) — `machine` stays `undefined`, which is why the Create button in `SpawnDialog` is permanently disabled (`disabled={createWorktree.isPending || !machine}`) and `ExpandedTerminal` shows "no machine assigned to this project" for any project that went through Clone with a machine selected.

## Global Constraints

- No frontend changes needed — `NewProjectDialog.tsx` already sends `machineId` correctly; only the backend drops/mishandles it.
- The `machineID == ""` (local/hub) code path in `ProjectService.Clone` must remain byte-identical to today — do not touch it, only add a new branch above/around it. Existing tests `TestProjectCloneClonesRepoThenCreatesProject` and `TestProjectCloneFailureDoesNotCreateProjectOrLeaveTarget` in `backend/internal/service/project_test.go` must keep passing unchanged.
- New runtime endpoint `POST /api/fs/clone` is registered on **both** roles, ungated by `isRuntime` — matching how `GET /api/fs/list` and `POST /api/fs/mkdir` are already registered unconditionally in `main.go`.
- Reuse `backend/internal/service/worktree_test.go`'s existing `mustInitGitRepo(t)` / `runGit(t, dir, args...)` helpers for any new test in package `service` that needs a real local git repo to clone from — they're already defined in that package, don't redefine them.
- `go vet ./...` and `go test ./...` before every commit. Run from `backend/`.
- `backend/cmd/server/main.go` is a listed convergence file — this plan touches it once, in Task 4, after Tasks 1–3 are committed. Do not parallelize Task 4 with anything else touching `main.go`.

---

### Task 1: `machineclient.CloneOnMachine`

**Files:**
- Create: `backend/internal/machineclient/clone.go`
- Test: `backend/internal/machineclient/clone_test.go`

**Interfaces (produced):**
```go
func CloneOnMachine(ctx context.Context, m domain.Machine, repo, path string) error
```
Consumed by Task 3's `ProjectService.Clone`.

- [ ] **Step 1: Write the failing tests**

```go
package machineclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"loom/backend/internal/domain"
)

func TestCloneOnMachineSendsRepoAndPathWithBearerKey(t *testing.T) {
	var gotAuth string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/api/fs/clone" || r.Method != http.MethodPost {
			t.Errorf("request = %s %s, want POST /api/fs/clone", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": gotBody["path"]})
	}))
	t.Cleanup(srv.Close)

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err != nil {
		t.Fatalf("CloneOnMachine: %v", err)
	}
	if gotAuth != "Bearer rtk" {
		t.Errorf("Authorization = %q, want Bearer rtk", gotAuth)
	}
	if gotBody["repo"] != "https://github.com/org/repo.git" || gotBody["path"] != "/home/user/dev/repo" {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestCloneOnMachineReturnsErrorMessageFromMachine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "clone destination already exists"})
	}))
	t.Cleanup(srv.Close)

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "clone destination already exists") {
		t.Errorf("error = %q, want it to contain the machine's error message", err.Error())
	}
}

func TestCloneOnMachineWrapsUnreachableError(t *testing.T) {
	m := domain.Machine{ID: "m-dead", URL: "http://127.0.0.1:1", Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err == nil {
		t.Fatal("expected an error for an unreachable machine, got nil")
	}
	if !strings.Contains(err.Error(), "m-dead") {
		t.Errorf("error = %q, want it to name the machine id", err.Error())
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/ -run TestCloneOnMachine -v`
Expected: FAIL — `undefined: CloneOnMachine`

- [ ] **Step 3: Implement** `backend/internal/machineclient/clone.go`:

```go
package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"loom/backend/internal/domain"
)

// cloneTimeout is generous compared to requestTimeout (used for quick reads
// like FetchWorktrees) because a real `git clone` can legitimately take much
// longer than 3 seconds.
const cloneTimeout = 2 * time.Minute

// CloneOnMachine asks the machine m to clone repo into path on its own
// filesystem, via its POST /api/fs/clone endpoint (see
// backend/internal/handler/fs.go Clone). Used by ProjectService.Clone when a
// project is being created with a non-empty machineId, so the actual git
// clone happens on the machine that will own the project, not on the hub.
func CloneOnMachine(ctx context.Context, m domain.Machine, repo, path string) error {
	ctx, cancel := context.WithTimeout(ctx, cloneTimeout)
	defer cancel()

	payload, err := json.Marshal(map[string]string{"repo": repo, "path": path})
	if err != nil {
		return err
	}
	url := strings.TrimRight(m.URL, "/") + "/api/fs/clone"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var body struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		msg := body.Error
		if msg == "" {
			msg = fmt.Sprintf("machine %s returned status %d", m.ID, resp.StatusCode)
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/ -v`
Expected: `PASS` for all `TestCloneOnMachine*` tests plus the existing `TestSelfRegister*`/`TestRunSelfRegisterLoop*` tests. Also `go vet ./internal/machineclient/`.

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/machineclient/clone.go internal/machineclient/clone_test.go
git commit -m "$(cat <<'EOF'
feat(machines): CloneOnMachine client for dispatching project clones to a runtime

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Runtime-side `POST /api/fs/clone` endpoint

**Files:**
- Modify: `backend/internal/handler/fs.go`
- Test: `backend/internal/handler/fs_test.go`

**Interfaces (produced):**
- `func (h *FsHandler) Clone(w http.ResponseWriter, r *http.Request)` — body `{"repo": string, "path": string}`, `201 {"path": "<resolved absolute path>"}` on success.

Contract (mirrors the validation `ProjectService.Clone` already does locally today, so behavior is consistent regardless of which machine actually performs the clone):
- `repo` required, must not contain `\x00`/`\r`/`\n`, must not start with `-` (git-flag-injection guard, same as `ProjectService.Clone`).
- `path` required (via the existing `resolveFsPath` helper — handles `~` expansion and rejects path traversal), and must resolve to an **absolute** path.
- The path's parent directory must already exist and be a directory; the path itself must **not** already exist (409 `Conflict` if it does).
- On success, runs the real `git clone` via the existing `gitpkg.Clone`; on failure, removes any partially-cloned directory and returns 400 with the git error message.

- [ ] **Step 1: Write the failing tests**

```go
func TestFsCloneClonesRealRepo(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	target := filepath.Join(t.TempDir(), "checkout")

	body, err := json.Marshal(map[string]string{"repo": origin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Fatalf("cloned README missing: %v", err)
	}
}

func TestFsCloneRejectsMissingRepo(t *testing.T) {
	body, err := json.Marshal(map[string]string{"path": filepath.Join(t.TempDir(), "checkout")})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestFsCloneRejectsDestinationThatAlreadyExists(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	target := t.TempDir() // already exists

	body, err := json.Marshal(map[string]string{"repo": origin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
}

func TestFsCloneRejectsRelativePath(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	body, err := json.Marshal(map[string]string{"repo": origin, "path": "relative/checkout"})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestFsCloneRemovesPartialCheckoutOnFailure(t *testing.T) {
	missingOrigin := filepath.Join(t.TempDir(), "does-not-exist")
	target := filepath.Join(t.TempDir(), "checkout")

	body, err := json.Marshal(map[string]string{"repo": missingOrigin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target stat = %v, want not exist", err)
	}
}

// mustInitGitRepoForFsTest mirrors internal/service/worktree_test.go's
// mustInitGitRepo/runGit — duplicated here because internal/handler can't
// import internal/service's test-only helpers across packages.
func mustInitGitRepoForFsTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGitForFsTest(t, dir, "init", "-b", "main")
	runGitForFsTest(t, dir, "config", "user.email", "test@example.com")
	runGitForFsTest(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitForFsTest(t, dir, "add", "README.md")
	runGitForFsTest(t, dir, "commit", "-m", "initial")
	return dir
}

func runGitForFsTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
```

Add `"os/exec"` to this test file's imports alongside the existing ones (`bytes`, `encoding/json`, `net/http`, `net/http/httptest`, `net/url`, `os`, `path/filepath`, `testing`, `loom/backend/internal/domain`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run TestFsClone -v`
Expected: FAIL — `rec.Code undefined` style errors are wrong; actual expected failure is a compile error `h.Clone undefined (type *FsHandler has no field or method Clone)`.

- [ ] **Step 3: Implement.** Add to `backend/internal/handler/fs.go`, after `Mkdir`:

```go
// Clone handles POST /api/fs/clone. It clones a git repository into path on
// this machine — the hub calls this on a runtime (via
// machineclient.CloneOnMachine) when "Clone from GitHub" targets a project
// assigned to that machine, instead of cloning onto the hub's own
// filesystem (see service/project.go Clone).
func (h *FsHandler) Clone(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Repo string `json:"repo"`
		Path string `json:"path"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	repo := strings.TrimSpace(body.Repo)
	if repo == "" {
		writeErr(w, http.StatusBadRequest, "repo is required")
		return
	}
	if strings.ContainsAny(repo, "\x00\r\n") || strings.HasPrefix(repo, "-") {
		writeErr(w, http.StatusBadRequest, "invalid repository url")
		return
	}
	resolved, ok := resolveFsPath(w, body.Path, "path is required")
	if !ok {
		return
	}
	if !filepath.IsAbs(resolved) {
		writeErr(w, http.StatusBadRequest, "clone destination must be an absolute path or start with ~")
		return
	}
	parent := filepath.Dir(resolved)
	info, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusBadRequest, "clone parent folder does not exist")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "clone parent is not a folder")
		return
	}
	if _, err := os.Stat(resolved); err == nil {
		writeErr(w, http.StatusConflict, "clone destination already exists")
		return
	} else if !os.IsNotExist(err) {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := gitpkg.Clone(repo, resolved); err != nil {
		_ = os.RemoveAll(resolved)
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": resolved})
}
```

Add `gitpkg "loom/backend/internal/git"` to `fs.go`'s import block (alongside the existing `net/http`, `os`, `path/filepath`, `sort`, `strings`, `loom/backend/internal/domain`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -v`
Expected: `PASS` for all `TestFsClone*` tests plus every pre-existing test in the package (`TestFsListDir*`, `TestFsMkdir*`, `TestRequireKey*`, `TestProxy*`, `TestMachine*`, etc.). Also `go vet ./...`.

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/handler/fs.go internal/handler/fs_test.go
git commit -m "$(cat <<'EOF'
feat(fs): runtime-side POST /api/fs/clone endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ProjectService.Clone` forwards to the target machine; `PostCloneProject` decodes `machineId`

**Files:**
- Modify: `backend/internal/service/project.go`
- Modify: `backend/internal/handler/project.go`
- Test: `backend/internal/service/project_test.go` (extend)
- Test: Create `backend/internal/handler/project_test.go`

**Interfaces (consumes):**
- `machineclient.CloneOnMachine(ctx context.Context, m domain.Machine, repo, path string) error` (Task 1)

**Interfaces (changed):**
- `ProjectService.Clone(wsID, name, path, repo, machineID string) (domain.Project, error)` — gains the trailing `machineID` param.

- [ ] **Step 1: Write the failing tests.** Add to `backend/internal/service/project_test.go`:

```go
func TestProjectCloneWithEmptyMachineIDStaysLocal(t *testing.T) {
	// This is the existing local-clone path, just calling Clone with the
	// new trailing machineID argument set to "" — must behave identically
	// to before this change.
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	origin := mustInitGitRepo(t)
	target := filepath.Join(t.TempDir(), "checkout")

	proj, err := svc.Clone(ws.ID, "", target, origin, "")
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if proj.MachineID != "" {
		t.Fatalf("MachineID = %q, want empty (local)", proj.MachineID)
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Fatalf("cloned README missing: %v", err)
	}
}

func TestProjectCloneWithMachineIDDispatchesToMachineAndPersistsIt(t *testing.T) {
	var gotRepo, gotPath string
	fakeMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotRepo, gotPath = body["repo"], body["path"]
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": gotPath})
	}))
	t.Cleanup(fakeMachine.Close)

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.CreateMachine("builder", fakeMachine.URL, "rt-key")
	if err != nil {
		t.Fatal(err)
	}

	proj, err := svc.Clone(ws.ID, "myproj", "/home/dev/myproj", "https://github.com/org/repo.git", m.ID)
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if proj.MachineID != m.ID {
		t.Fatalf("MachineID = %q, want %q", proj.MachineID, m.ID)
	}
	if proj.Path != "/home/dev/myproj" {
		t.Fatalf("Path = %q, want /home/dev/myproj", proj.Path)
	}
	if gotRepo != "https://github.com/org/repo.git" || gotPath != "/home/dev/myproj" {
		t.Fatalf("machine received repo=%q path=%q", gotRepo, gotPath)
	}
	// The hub's own filesystem must NOT have been touched.
	if _, err := os.Stat("/home/dev/myproj"); !os.IsNotExist(err) {
		t.Fatalf("hub-local path should not exist, stat = %v", err)
	}
}

func TestProjectCloneWithMachineIDFailureDoesNotCreateProject(t *testing.T) {
	deadMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "clone destination already exists"})
	}))
	deadMachine.Close() // close immediately: guarantees an unreachable machine

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	svc := NewProjectService(st)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.CreateMachine("builder", deadMachine.URL, "rt-key")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Clone(ws.ID, "myproj", "/home/dev/myproj", "https://github.com/org/repo.git", m.ID); err == nil {
		t.Fatal("Clone succeeded, want an error for an unreachable machine")
	}
	workspaces, err := st.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces[0].Projects) != 0 {
		t.Fatalf("projects = %#v, want none created on failure", workspaces[0].Projects)
	}
}
```

Add `"encoding/json"`, `"net/http"`, `"net/http/httptest"` to `project_test.go`'s imports.

Also update the two pre-existing calls in this file to pass the new trailing argument (they test the local/`""` path, which must stay behaviorally identical):
- `TestProjectCloneClonesRepoThenCreatesProject`: change `svc.Clone(ws.ID, "", target, origin)` to `svc.Clone(ws.ID, "", target, origin, "")`.
- `TestProjectCloneFailureDoesNotCreateProjectOrLeaveTarget`: change `svc.Clone(ws.ID, "broken", target, missingOrigin)` to `svc.Clone(ws.ID, "broken", target, missingOrigin, "")`.

Create `backend/internal/handler/project_test.go`:

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func newTestProjectHandler(t *testing.T) (*ProjectHandler, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewProjectHandler(service.NewProjectService(st)), st
}

func TestPostCloneProjectDecodesMachineID(t *testing.T) {
	var gotAuth string
	fakeMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"path":"/home/dev/myproj"}`))
	}))
	t.Cleanup(fakeMachine.Close)

	h, st := newTestProjectHandler(t)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.CreateMachine("builder", fakeMachine.URL, "rt-key")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+ws.ID+"/projects/clone",
		strings.NewReader(`{"name":"myproj","path":"/home/dev/myproj","repo":"https://github.com/org/repo.git","machineId":"`+m.ID+`"}`))
	req.SetPathValue("wsId", ws.ID)
	rec := httptest.NewRecorder()
	h.PostCloneProject(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"machineId":"`+m.ID+`"`) {
		t.Errorf("response body = %s, want it to include machineId %q", rec.Body.String(), m.ID)
	}
	if gotAuth != "Bearer rt-key" {
		t.Errorf("machine saw Authorization = %q, want Bearer rt-key", gotAuth)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/ ./internal/handler/ -run 'TestProjectClone|TestPostCloneProject' -v`
Expected: FAIL — compile errors (`not enough arguments in call to svc.Clone`, `h.svc.Clone` signature mismatch once Task's handler change is attempted, `undefined: newTestProjectHandler` before it's added, etc.) — i.e. the tests don't compile/pass against the current signatures.

- [ ] **Step 3: Implement.**

In `backend/internal/service/project.go`, add the import `"context"` and `"loom/backend/internal/machineclient"` to the import block, then replace the `Clone` function:

```go
// Clone clones a git repository into path, then creates a project for the
// completed checkout. The DB row is not written until the clone succeeds.
//
// If machineID is empty, the clone happens locally on the hub's own
// filesystem (this branch's behavior is unchanged from before machine
// dispatch existed). If machineID is set, the clone is dispatched to that
// machine via machineclient.CloneOnMachine instead — the hub's own
// filesystem is never touched in that case.
func (svc *ProjectService) Clone(wsID, name, path, repo, machineID string) (domain.Project, error) {
	name = strings.TrimSpace(name)
	path = strings.TrimSpace(path)
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return domain.Project{}, fmt.Errorf("github repository url is required: %w", ErrValidation)
	}
	if strings.ContainsAny(repo, "\x00\r\n") || strings.HasPrefix(repo, "-") {
		return domain.Project{}, fmt.Errorf("invalid repository url: %w", ErrValidation)
	}
	if path == "" {
		folder := repoFolderName(repo)
		if name != "" {
			folder = name
		}
		if folder == "" {
			return domain.Project{}, fmt.Errorf("clone destination is required: %w", ErrValidation)
		}
		path = "~/dev/" + folder
	}
	if strings.ContainsRune(path, '\x00') {
		return domain.Project{}, fmt.Errorf("invalid clone destination: %w", ErrValidation)
	}
	if name == "" {
		name = lastSegment(path)
	}
	if name == "" {
		name = repoFolderName(repo)
	}
	if name == "" {
		name = "new-project"
	}

	if machineID != "" {
		machine, err := svc.store.MachineByID(machineID)
		if err != nil {
			return domain.Project{}, err
		}
		if err := machineclient.CloneOnMachine(context.Background(), machine, repo, path); err != nil {
			return domain.Project{}, fmt.Errorf("%s: %w", err.Error(), ErrValidation)
		}
		return svc.store.CreateProject(wsID, name, path, repo, machineID)
	}

	resolved := gitpkg.ExpandHome(path)
	if !filepath.IsAbs(resolved) {
		return domain.Project{}, fmt.Errorf("clone destination must be an absolute path or start with ~: %w", ErrValidation)
	}
	parent := filepath.Dir(resolved)
	info, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			return domain.Project{}, fmt.Errorf("clone parent folder does not exist: %w", ErrValidation)
		}
		return domain.Project{}, fmt.Errorf("inspect clone parent folder: %w", ErrValidation)
	}
	if !info.IsDir() {
		return domain.Project{}, fmt.Errorf("clone parent is not a folder: %w", ErrValidation)
	}
	if _, err := os.Stat(resolved); err == nil {
		return domain.Project{}, fmt.Errorf("clone destination already exists: %w", ErrConflict)
	} else if !os.IsNotExist(err) {
		return domain.Project{}, fmt.Errorf("inspect clone destination: %w", ErrValidation)
	}

	if err := gitpkg.Clone(repo, path); err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, fmt.Errorf("%s: %w", err.Error(), ErrValidation)
	}
	project, err := svc.store.CreateProject(wsID, name, path, repo, "")
	if err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, err
	}
	return project, nil
}
```

(Note: the `machineID != ""` branch is placed *before* the local-path resolution/validation block precisely so it never touches the hub's own filesystem at all — no `os.Stat`, no `filepath.IsAbs` check against the hub's paths, since those checks now happen on the remote machine inside `FsHandler.Clone`, Task 2.)

In `backend/internal/handler/project.go`, update `PostCloneProject`:

```go
// PostCloneProject clones a git repository, then creates a project for it.
func (h *ProjectHandler) PostCloneProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      *string `json:"name"`
		Path      *string `json:"path"`
		Repo      *string `json:"repo"`
		MachineID *string `json:"machineId"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	p, err := h.svc.Clone(r.PathValue("wsId"), str(body.Name), str(body.Path), str(body.Repo), str(body.MachineID))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ ./internal/handler/ -v`
Expected: `PASS` for every test in both packages, including all pre-existing ones (this confirms the local/`""` path is unaffected). Also `go vet ./...`.

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/service/project.go internal/service/project_test.go internal/handler/project.go internal/handler/project_test.go
git commit -m "$(cat <<'EOF'
fix(projects): clone onto the selected machine and persist its machineId

Cloning a project previously always ran on the hub's own filesystem and
silently dropped whatever machine was selected in the UI (machineId always
ended up ""), which permanently disabled spawning/opening that project
since the frontend can never resolve a machine for an empty machineId.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Route registration + end-to-end verification

**Files:**
- Modify: `backend/cmd/server/main.go`

No unit test target for this file (matches the existing pattern — `main.go` has no test file in this repo). Verification is build + a real two-process clone-onto-a-runtime smoke test.

- [ ] **Step 1: Register the route.** In `main.go`, find:

```go
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)
	mux.HandleFunc("POST /api/fs/mkdir", fsH.Mkdir)
```

Add a third line directly after it:

```go
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)
	mux.HandleFunc("POST /api/fs/mkdir", fsH.Mkdir)
	mux.HandleFunc("POST /api/fs/clone", fsH.Clone)
```

- [ ] **Step 2: Verify — build, then a real two-process clone-onto-runtime smoke test**

```bash
cd backend && go build -o /tmp/loom_verify ./cmd/server && go vet ./... && go test ./...
```

```bash
rm -rf /tmp/verify-hub.db* /tmp/verify-rt.db* /tmp/verify-clone-target
/tmp/loom_verify --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/verify-hub.db --open=false &
/tmp/loom_verify --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/verify-rt.db --open=false &
sleep 1

curl -s -X POST -H 'Authorization: Bearer hubk' -H 'Content-Type: application/json' \
  -d '{"name":"rt","url":"http://127.0.0.1:9199","key":"rtk"}' http://127.0.0.1:9198/api/machines
MID=$(curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

WS=$(curl -s -X POST -H 'Authorization: Bearer hubk' -H 'Content-Type: application/json' -d '{"name":"verify-ws"}' http://127.0.0.1:9198/api/workspaces)
WSID=$(echo "$WS" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo "=== clone onto the runtime machine ==="
curl -s -X POST -H 'Authorization: Bearer hubk' -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-proj\",\"path\":\"/tmp/verify-clone-target\",\"repo\":\"https://github.com/octocat/Hello-World.git\",\"machineId\":\"$MID\"}" \
  http://127.0.0.1:9198/api/workspaces/$WSID/projects/clone
# expect: response includes "machineId":"<MID>" (not "")

echo "=== confirm the clone landed on the runtime, NOT the hub ==="
ls /tmp/verify-clone-target   # must exist — cloned by the runtime process, same box in this dev test

kill %1 %2
```

Expected: the clone response's `machineId` field matches the registered machine's id (not `""`), and the checkout appears at the given path. Combined with the machineId fix, opening this project's worktree in the UI (`ExpandedTerminal`) and the Spawn dialog will now correctly resolve `machine` instead of showing "no machine assigned" / a permanently disabled Create button.

- [ ] **Step 3: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "$(cat <<'EOF'
feat(fs): register POST /api/fs/clone route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification (end-to-end)

```bash
cd backend && go vet ./... && go test ./...
cd ../frontend && npm run typecheck   # unaffected by this plan; confirms no regression
```

Plus the real two-process clone smoke test from Task 4 Step 2. Also spot-check in a real browser once this lands: register a runtime machine, "Clone from GitHub" a small public repo onto it, confirm the project immediately shows a resolvable machine (Spawn button enabled, `ExpandedTerminal` doesn't show "no machine assigned"), and that the repo was cloned on the runtime's filesystem, not the hub's.
