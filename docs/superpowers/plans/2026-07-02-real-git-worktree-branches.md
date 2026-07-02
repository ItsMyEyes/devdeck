# Real git branches for worktree creation, checkout, and conflict prevention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace simulated worktree branch handling with real `git` operations: list actual repository branches, create real `git worktree` checkouts on disk, prevent two worktrees from checking out the same branch, and allow changing a worktree's branch via a real `git checkout`.

**Architecture:** A new `backend/internal/git` package wraps `os/exec` calls to the `git` binary (argv-only, no shell strings). `WorktreeService.Create`/`Delete`/`Update` call into it to make worktree lifecycle operations real, with DB-row rollback if the git command fails. A new `GET /api/projects/{id}/branches` endpoint feeds two frontend `<Select>` dropdowns (Spawn dialog's Base field, Edit drawer's branch field) via a shared `useProjectBranches` query hook.

**Tech Stack:** Go 1.22+ stdlib `os/exec` (no third-party git library), SQLite via existing `port.Store`, React 19 + `@tanstack/react-query` + `@base-ui/react` Select.

## Global Constraints

- Module path is `loom/backend`. New package: `loom/backend/internal/git`.
- All git commands use `exec.Command("git", argv...)` — never build a shell string. Branch/base names are validated against `^[A-Za-z0-9._/-]+$` and rejected if they start with `-`, before being passed as arguments.
- Real git commands require the `git` binary on `PATH` and `project.Path` to be a valid repository for any branch-mode operation. Root-mode worktrees never touch git.
- New sentinel errors `service.ErrValidation` (→ HTTP 400) and `service.ErrConflict` (→ HTTP 409) extend `handleStoreErr` in `backend/internal/handler/middleware.go`. Every other error still falls through to 500, per existing convention.
- Frontend: use the `@/*` import alias, never relative paths into `src/`. `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Run `go vet ./... && go test ./...` (from `backend/`) and `npm run typecheck` (from `frontend/`) before every checkpoint.
- **This directory is not a git repository** (`git status` returns "fatal: not a git repository"). Every task below ends with a "Checkpoint" step instead of a `git commit` step — just verify the build/tests are green and move on. Do not run `git init` or `git commit` unless the user explicitly asks for it.

---

### Task 1: `internal/git` package — branch listing

**Files:**
- Create: `backend/internal/git/git.go`
- Test: `backend/internal/git/git_test.go`

**Interfaces:**
- Produces: `git.ListBranches(repoPath string) ([]string, error)`, unexported `validRef(name string) bool`, unexported `run(args ...string) (string, error)`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/git/git_test.go`:

```go
package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// initTestRepo creates a temporary git repository with an initial commit on
// "main" and returns its path.
func initTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-m", "initial")
	return dir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestListBranchesOnFreshRepo(t *testing.T) {
	repo := initTestRepo(t)
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 1 || branches[0] != "main" {
		t.Errorf("ListBranches = %v, want [main]", branches)
	}
}

func TestListBranchesIncludesAdditionalBranches(t *testing.T) {
	repo := initTestRepo(t)
	runGit(t, repo, "branch", "feat/x")
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("ListBranches = %v, want 2 branches", branches)
	}
}

func TestValidRefRejectsFlagLikeNames(t *testing.T) {
	cases := map[string]bool{
		"main":          true,
		"feat/my-thing": true,
		"release-1.2":   true,
		"-x":            false,
		"--force":       false,
		"":               false,
		"has space":     false,
	}
	for name, want := range cases {
		if got := validRef(name); got != want {
			t.Errorf("validRef(%q) = %v, want %v", name, got, want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/git/...`
Expected: FAIL — `package loom/backend/internal/git is not in std` / `ListBranches undefined` (package doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/git/git.go`:

```go
// Package git wraps the git CLI for worktree branch operations. All commands
// use exec.Command with an argument slice — never a shell string — so there
// is no shell-injection surface. Branch/base names are additionally
// validated so a crafted name can't be interpreted as a git flag.
package git

import (
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var refNamePattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// validRef reports whether name is safe to pass as a git ref argument.
func validRef(name string) bool {
	return name != "" && !strings.HasPrefix(name, "-") && refNamePattern.MatchString(name)
}

func run(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// ListBranches returns the local branch names of the repository at repoPath.
func ListBranches(repoPath string) ([]string, error) {
	out, err := run("-C", repoPath, "branch", "--format=%(refname:short)")
	if err != nil {
		return nil, err
	}
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/git/... -v`
Expected: PASS — `TestListBranchesOnFreshRepo`, `TestListBranchesIncludesAdditionalBranches`, `TestValidRefRejectsFlagLikeNames` all pass.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors. No git repo here — just confirm green and move to Task 2.

---

### Task 2: `internal/git` package — AddWorktree and RemoveWorktree

**Files:**
- Modify: `backend/internal/git/git.go`
- Modify: `backend/internal/git/git_test.go`

**Interfaces:**
- Consumes: `run`, `validRef` (Task 1, same package, unexported).
- Produces: `git.AddWorktree(repoPath, worktreePath, branch, base string) error`, `git.RemoveWorktree(repoPath, worktreePath string) error`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/git/git_test.go`:

```go
func TestAddWorktreeCreatesRealDirectoryAndBranch(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/new-thing", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if _, err := os.Stat(wtPath); err != nil {
		t.Errorf("expected worktree directory to exist: %v", err)
	}
	branches, err := ListBranches(repo)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	found := false
	for _, b := range branches {
		if b == "feat/new-thing" {
			found = true
		}
	}
	if !found {
		t.Errorf("ListBranches = %v, want it to include feat/new-thing", branches)
	}
}

func TestAddWorktreeRejectsInvalidBranchName(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "--force", "main"); err == nil {
		t.Error("expected error for flag-like branch name, got nil")
	}
}

func TestRemoveWorktreeDeletesDirectory(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/removable", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := RemoveWorktree(repo, wtPath); err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("expected worktree directory to be gone, stat err = %v", err)
	}
}

func TestRemoveWorktreeIsIdempotent(t *testing.T) {
	repo := initTestRepo(t)
	wtPath := filepath.Join(t.TempDir(), "never-created")
	if err := RemoveWorktree(repo, wtPath); err != nil {
		t.Errorf("RemoveWorktree on unregistered path should be a no-op, got: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/git/... -run 'AddWorktree|RemoveWorktree' -v`
Expected: FAIL — `AddWorktree undefined`, `RemoveWorktree undefined`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/internal/git/git.go`:

```go
// AddWorktree creates a new git worktree at worktreePath, checking out a new
// branch named branch created from base.
func AddWorktree(repoPath, worktreePath, branch, base string) error {
	if !validRef(branch) {
		return fmt.Errorf("invalid branch name %q", branch)
	}
	if !validRef(base) {
		return fmt.Errorf("invalid base branch name %q", base)
	}
	_, err := run("-C", repoPath, "worktree", "add", "-b", branch, worktreePath, base)
	return err
}

// RemoveWorktree removes the git worktree at worktreePath from repoPath's
// registry. It is idempotent: if worktreePath isn't a registered worktree,
// it returns nil rather than an error.
func RemoveWorktree(repoPath, worktreePath string) error {
	_, err := run("-C", repoPath, "worktree", "remove", worktreePath)
	if err != nil && strings.Contains(err.Error(), "is not a working tree") {
		return nil
	}
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/git/... -v`
Expected: PASS — all tests in the package, including Task 1's.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 3: `internal/git` package — Checkout

**Files:**
- Modify: `backend/internal/git/git.go`
- Modify: `backend/internal/git/git_test.go`

**Interfaces:**
- Consumes: `run`, `validRef`, `AddWorktree` (Tasks 1-2, same package).
- Produces: `git.Checkout(worktreePath, branch string) error`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/git/git_test.go`:

```go
func TestCheckoutSwitchesToExistingBranch(t *testing.T) {
	repo := initTestRepo(t)
	runGit(t, repo, "branch", "feat/target")
	wtPath := filepath.Join(t.TempDir(), "wt1")
	if err := AddWorktree(repo, wtPath, "feat/start", "main"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := Checkout(wtPath, "feat/target"); err != nil {
		t.Fatalf("Checkout: %v", err)
	}
	current := strings.TrimSpace(mustRunGit(t, wtPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if current != "feat/target" {
		t.Errorf("current branch = %q, want feat/target", current)
	}
}

func TestCheckoutFailsWhenBranchAlreadyCheckedOutElsewhere(t *testing.T) {
	repo := initTestRepo(t)
	wtA := filepath.Join(t.TempDir(), "wtA")
	wtB := filepath.Join(t.TempDir(), "wtB")
	if err := AddWorktree(repo, wtA, "feat/a", "main"); err != nil {
		t.Fatalf("AddWorktree A: %v", err)
	}
	if err := AddWorktree(repo, wtB, "feat/b", "main"); err != nil {
		t.Fatalf("AddWorktree B: %v", err)
	}
	// feat/b is already checked out at wtB — checking it out at wtA must fail,
	// proving real git enforces the one-worktree-per-branch constraint.
	if err := Checkout(wtA, "feat/b"); err == nil {
		t.Error("expected Checkout to fail for a branch already checked out elsewhere, got nil")
	}
}

func mustRunGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}
```

Add `"strings"` to the test file's imports if not already present (it already imports it transitively via the package — check the top of `git_test.go`; if `strings` isn't imported yet, add it to the `import` block).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/git/... -run Checkout -v`
Expected: FAIL — `Checkout undefined`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/internal/git/git.go`:

```go
// Checkout switches worktreePath's checked-out branch to branch, which must
// already exist in the repository.
func Checkout(worktreePath, branch string) error {
	if !validRef(branch) {
		return fmt.Errorf("invalid branch name %q", branch)
	}
	_, err := run("-C", worktreePath, "checkout", branch)
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/git/... -v`
Expected: PASS — every test in the package.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 4: Service-layer error sentinels

**Files:**
- Create: `backend/internal/service/errors.go`
- Modify: `backend/internal/handler/middleware.go:26-38`
- Test: `backend/internal/handler/middleware_test.go` (new file)

**Interfaces:**
- Produces: `service.ErrValidation` (wrap with `fmt.Errorf("...: %w", service.ErrValidation)` → HTTP 400), `service.ErrConflict` (→ HTTP 409).
- Consumes (Task 5-7 will use these sentinels when returning validation/conflict errors from `WorktreeService`).

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/middleware_test.go`:

```go
package handler

import (
	"fmt"
	"net/http/httptest"
	"testing"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func TestHandleStoreErrMapsValidationTo400(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("base branch %q not found: %w", "nope", service.ErrValidation)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 400 {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleStoreErrMapsConflictTo409(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("branch %q already in use: %w", "feat/x", service.ErrConflict)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 409 {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestHandleStoreErrStillMapsNotFoundTo404(t *testing.T) {
	rec := httptest.NewRecorder()
	if !handleStoreErr(rec, store.ErrNotFound) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/... -run HandleStoreErr -v`
Expected: FAIL — `service.ErrValidation undefined`, `service.ErrConflict undefined`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/service/errors.go`:

```go
package service

import "errors"

// ErrValidation indicates the caller supplied invalid input. Wrap it with
// fmt.Errorf("...: %w", ErrValidation) — handleStoreErr maps it to HTTP 400.
var ErrValidation = errors.New("validation")

// ErrConflict indicates the requested change conflicts with existing state
// (e.g. a branch already checked out by another worktree). Wrap it with
// fmt.Errorf("...: %w", ErrConflict) — handleStoreErr maps it to HTTP 409.
var ErrConflict = errors.New("conflict")
```

Modify `backend/internal/handler/middleware.go` — add the `service` import and extend `handleStoreErr` (lines 26-38):

```go
// handleStoreErr maps a store error onto an HTTP response. Returns true when it
// wrote a response (i.e. there was an error).
func handleStoreErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not found")
		return true
	}
	if errors.Is(err, service.ErrValidation) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return true
	}
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, err.Error())
		return true
	}
	writeErr(w, http.StatusInternalServerError, err.Error())
	return true
}
```

And add `"loom/backend/internal/service"` to the import block at the top of `middleware.go` (alongside the existing `"loom/backend/internal/store"` import).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 5: `WorktreeService.Create` — real worktree creation

**Files:**
- Modify: `backend/internal/service/worktree.go:25-37`
- Modify: `backend/internal/service/worktree_test.go`

**Interfaces:**
- Consumes: `git.ListBranches`, `git.AddWorktree` (Tasks 1-2), `service.ErrValidation`, `service.ErrConflict` (Task 4), `store.ProjectByID(id) (domain.Project, error)` (existing, returns `domain.Project{Path, Worktrees}`).
- Produces: updated `WorktreeService.Create` — same signature, now performs real git operations for `mode == "branch"`.

- [ ] **Step 1: Write the failing test**

Add a shared test helper and new test cases to `backend/internal/service/worktree_test.go`. First, add the helper near `mustCreateWorktree`:

```go
// mustInitGitRepo creates a temporary git repository with an initial commit
// on "main" and returns its path, for tests that exercise real git
// operations through WorktreeService.
func mustInitGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-m", "initial")
	return dir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
```

Update the imports at the top of `backend/internal/service/worktree_test.go` to add `"os"`, `"os/exec"`:

```go
import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)
```

Update `TestCreateDefaultsModelOnlyForBranchMode` to use a real repo (replace the `"/tmp/core"` project path):

```go
func TestCreateDefaultsModelOnlyForBranchMode(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	root, err := svc.Create(proj.ID, "root", "", "", "", "")
	if err != nil {
		t.Fatalf("Create (root): %v", err)
	}
	if root.Model != "" {
		t.Errorf("root mode Model = %q, want empty (no agent should be assumed)", root.Model)
	}

	branch, err := svc.Create(proj.ID, "branch", "", "", "", "")
	if err != nil {
		t.Fatalf("Create (branch): %v", err)
	}
	if branch.Model != "claude-sonnet-5" {
		t.Errorf("branch mode Model = %q, want default %q", branch.Model, "claude-sonnet-5")
	}
}
```

Add new tests:

```go
func TestCreateBranchModeMakesRealWorktree(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := svc.Create(proj.ID, "branch", "feat/real-thing", "main", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)
	if _, err := os.Stat(wtPath); err != nil {
		t.Errorf("expected real worktree directory at %s: %v", wtPath, err)
	}
}

func TestCreateRejectsUnknownBaseBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Create(proj.ID, "branch", "feat/x", "does-not-exist", "", "")
	if err == nil {
		t.Fatal("expected error for unknown base branch, got nil")
	}
}

func TestCreateRejectsBranchAlreadyUsedByAnotherWorktree(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(proj.ID, "branch", "feat/taken", "main", "", ""); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	_, err = svc.Create(proj.ID, "branch", "feat/taken", "main", "", "")
	if err == nil {
		t.Fatal("expected conflict error for a branch already used by another worktree, got nil")
	}
}

func TestCreateRollsBackRowWhenGitAddFails(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	// A plain branch named "feat/exists" that no worktree has checked out —
	// our conflict pre-check passes, but `git worktree add -b` itself must
	// fail because the branch name already exists.
	runGit(t, repoPath, "branch", "feat/exists")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	before, err := st.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Create(proj.ID, "branch", "feat/exists", "main", "", "")
	if err == nil {
		t.Fatal("expected git worktree add to fail for a branch name that already exists, got nil")
	}
	after, err := st.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Worktrees) != len(before.Worktrees) {
		t.Errorf("expected DB row to be rolled back on git failure: before=%d worktrees, after=%d", len(before.Worktrees), len(after.Worktrees))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/... -run 'TestCreate' -v`
Expected: FAIL — `TestCreateBranchModeMakesRealWorktree`, `TestCreateRejectsUnknownBaseBranch`, `TestCreateRejectsBranchAlreadyUsedByAnotherWorktree`, `TestCreateRollsBackRowWhenGitAddFails` all fail because `Create` doesn't validate or touch git yet. (`TestCreateDefaultsModelOnlyForBranchMode` should still pass unchanged, since real git creation currently no-ops — confirm it doesn't regress.)

- [ ] **Step 3: Write minimal implementation**

Replace `Create` in `backend/internal/service/worktree.go` (lines 25-37):

```go
// Create creates a worktree. Branch mode always spawns an agent, so an empty
// model defaults to "claude-sonnet-5". Root mode is a plain shell terminal —
// an empty model there must stay empty, or resolveCommand would treat it as
// an agent session (see backend/internal/terminal/server.go resolveCommand).
//
// Branch mode performs a real git worktree checkout: it validates base
// exists in the repository, rejects a branch already used by another
// worktree in the project, creates the DB row, then runs `git worktree add`.
// If the git command fails, the DB row is rolled back so the database never
// points at a worktree that doesn't exist on disk.
func (svc *WorktreeService) Create(projectID, mode, branch, base, model, task string) (domain.Worktree, error) {
	branch = strings.TrimSpace(branch)
	base = strings.TrimSpace(base)
	model = strings.TrimSpace(model)
	if model == "" && mode == "branch" {
		model = "claude-sonnet-5"
	}
	if mode != "branch" {
		return svc.store.CreateWorktree(projectID, mode, branch, base, model, task)
	}

	proj, err := svc.store.ProjectByID(projectID)
	if err != nil {
		return domain.Worktree{}, err
	}
	if base == "" {
		base = "main"
	}
	branches, err := gitpkg.ListBranches(proj.Path)
	if err != nil {
		return domain.Worktree{}, fmt.Errorf("list branches: %w", err)
	}
	if !containsStr(branches, base) {
		return domain.Worktree{}, fmt.Errorf("base branch %q not found in repository: %w", base, ErrValidation)
	}
	if branch != "" {
		for _, w := range proj.Worktrees {
			if w.Branch == branch {
				return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", branch, ErrConflict)
			}
		}
	}

	wt, err := svc.store.CreateWorktree(projectID, mode, branch, base, model, task)
	if err != nil {
		return domain.Worktree{}, err
	}

	worktreePath := filepath.Join(proj.Path, ".wt", wt.ID)
	if err := gitpkg.AddWorktree(proj.Path, worktreePath, wt.Branch, base); err != nil {
		_ = svc.store.DeleteWorktree(wt.ID)
		return domain.Worktree{}, fmt.Errorf("git worktree add: %w", err)
	}
	return wt, nil
}

func containsStr(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
```

Update the import block at the top of `backend/internal/service/worktree.go`:

```go
import (
	"fmt"
	"path/filepath"
	"strings"

	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)
```

(`gitpkg` alias avoids shadowing the standard library naming convention and keeps call sites unambiguous — `git` as a bare identifier reads oddly next to `git.CreateWorktree`-style store methods.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/... -v`
Expected: PASS — every test in the package, including the untouched `TestDeleteKillsRunningAgentBeforeRemovingRow`.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 6: `WorktreeService.Delete` — real cleanup

**Files:**
- Modify: `backend/internal/service/worktree.go` (the `Delete` method)
- Modify: `backend/internal/service/worktree_test.go`

**Interfaces:**
- Consumes: `git.RemoveWorktree` (Task 2), `containsStr`/`gitpkg` import already added in Task 5.
- Produces: updated `WorktreeService.Delete` — same signature, now removes the real git worktree directory for non-root worktrees before deleting the DB row.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/service/worktree_test.go`:

```go
func TestDeleteRemovesRealGitWorktreeDirectory(t *testing.T) {
	svc, st := newTestSvc(t, func(string) error { return nil })
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, "branch", "feat/to-delete", "main", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)

	if err := svc.Delete(wt.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("expected worktree directory to be removed, stat err = %v", err)
	}
	if _, err := st.WorktreeByID(wt.ID); err == nil {
		t.Error("expected worktree row to be removed after Delete")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/... -run TestDeleteRemovesRealGitWorktreeDirectory -v`
Expected: FAIL — the directory still exists after `Delete`, since `Delete` doesn't call `git.RemoveWorktree` yet.

- [ ] **Step 3: Write minimal implementation**

Replace `Delete` in `backend/internal/service/worktree.go`:

```go
// Delete stops the worktree's background agent (if running), removes its
// real git worktree checkout from disk (unless it's the project root), and
// deletes the DB row.
func (svc *WorktreeService) Delete(id string) error {
	wt, err := svc.store.WorktreeByID(id)
	if err != nil {
		return err
	}
	if svc.kill != nil {
		if err := svc.kill(id); err != nil {
			return err
		}
	}
	if !wt.Root {
		proj, err := svc.store.ProjectByID(wt.ProjectID)
		if err != nil {
			return err
		}
		worktreePath := filepath.Join(proj.Path, ".wt", id)
		if err := gitpkg.RemoveWorktree(proj.Path, worktreePath); err != nil {
			return fmt.Errorf("git worktree remove: %w", err)
		}
	}
	return svc.store.DeleteWorktree(id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/... -v`
Expected: PASS — every test in the package, including `TestDeleteKillsRunningAgentBeforeRemovingRow` (root-mode worktree from `mustCreateWorktree`, whose fake `/tmp/core` path is never touched by git since `wt.Root == true` skips the git branch entirely).

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 7: `WorktreeService.Update` — real branch checkout

**Files:**
- Modify: `backend/internal/service/worktree.go` (the `Update` method)
- Modify: `backend/internal/service/worktree_test.go`

**Interfaces:**
- Consumes: `git.Checkout` (Task 3), `ErrConflict` (Task 4).
- Produces: updated `WorktreeService.Update` — same signature. When `p.Branch` differs from the worktree's current branch: blocks if `state` is `running`/`waiting`, rejects if another active worktree already has that branch, then runs a real `git checkout` before persisting.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/service/worktree_test.go`:

```go
func TestUpdateChecksOutExistingBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/other")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, "branch", "feat/start", "main", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := st.UpdateWorktree(wt.ID, port.WorktreePatch{State: strPtr("idle")}); err != nil {
		t.Fatalf("seed idle state: %v", err)
	}

	newBranch := "feat/other"
	updated, err := svc.Update(wt.ID, port.WorktreePatch{Branch: &newBranch})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Branch != "feat/other" {
		t.Errorf("Branch = %q, want feat/other", updated.Branch)
	}
	wtPath := filepath.Join(repoPath, ".wt", wt.ID)
	current := strings.TrimSpace(mustRunGit(t, wtPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if current != "feat/other" {
		t.Errorf("real checked-out branch = %q, want feat/other", current)
	}
}

func TestUpdateRejectsBranchChangeWhileRunning(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/other")
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := svc.Create(proj.ID, "branch", "feat/start", "main", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Create leaves the worktree in state "running" by default (see store.CreateWorktree).

	newBranch := "feat/other"
	if _, err := svc.Update(wt.ID, port.WorktreePatch{Branch: &newBranch}); err == nil {
		t.Fatal("expected error when changing branch while running, got nil")
	}
}

func TestUpdateRejectsConflictingBranch(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	repoPath := mustInitGitRepo(t)
	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	a, err := svc.Create(proj.ID, "branch", "feat/a", "main", "", "")
	if err != nil {
		t.Fatalf("Create a: %v", err)
	}
	b, err := svc.Create(proj.ID, "branch", "feat/b", "main", "", "")
	if err != nil {
		t.Fatalf("Create b: %v", err)
	}
	if _, err := st.UpdateWorktree(a.ID, port.WorktreePatch{State: strPtr("idle")}); err != nil {
		t.Fatalf("seed idle state: %v", err)
	}

	takenBranch := b.Branch
	if _, err := svc.Update(a.ID, port.WorktreePatch{Branch: &takenBranch}); err == nil {
		t.Fatal("expected conflict error checking out a branch already used by another worktree, got nil")
	}
}

func strPtr(s string) *string { return &s }
```

Add `"strings"` to the imports of `backend/internal/service/worktree_test.go` if it isn't already there from Task 5.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/... -run 'TestUpdate' -v`
Expected: FAIL — `TestUpdateChecksOutExistingBranch` fails because the branch never actually changes on disk; `TestUpdateRejectsBranchChangeWhileRunning` and `TestUpdateRejectsConflictingBranch` fail because `Update` currently accepts any branch change unconditionally.

- [ ] **Step 3: Write minimal implementation**

Replace `Update` in `backend/internal/service/worktree.go`:

```go
// Update patches a worktree's fields. If Branch is set and differs from the
// worktree's current branch, this performs a real git checkout: it blocks
// while the worktree is running/waiting (pause first), rejects a branch
// already checked out by another worktree in the project, then runs
// `git checkout` before persisting the new branch value.
func (svc *WorktreeService) Update(id string, p port.WorktreePatch) (domain.Worktree, error) {
	if p.Branch != nil {
		wt, err := svc.store.WorktreeByID(id)
		if err != nil {
			return domain.Worktree{}, err
		}
		newBranch := strings.TrimSpace(*p.Branch)
		if newBranch != "" && newBranch != wt.Branch {
			if wt.State == "running" || wt.State == "waiting" {
				return domain.Worktree{}, fmt.Errorf("pause the worktree before changing its branch: %w", ErrConflict)
			}
			proj, err := svc.store.ProjectByID(wt.ProjectID)
			if err != nil {
				return domain.Worktree{}, err
			}
			for _, sibling := range proj.Worktrees {
				if sibling.ID != id && sibling.Branch == newBranch {
					return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", newBranch, ErrConflict)
				}
			}
			worktreePath := proj.Path
			if !wt.Root {
				worktreePath = filepath.Join(proj.Path, ".wt", id)
			}
			if err := gitpkg.Checkout(worktreePath, newBranch); err != nil {
				return domain.Worktree{}, fmt.Errorf("git checkout: %w", err)
			}
		}
	}
	return svc.store.UpdateWorktree(id, p)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/... -v`
Expected: PASS — every test in the package.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./... && go test ./...`
Expected: no errors, full backend test suite green.

---

### Task 8: `GET /api/projects/{id}/branches` endpoint

**Files:**
- Modify: `backend/internal/service/project.go`
- Modify: `backend/internal/handler/project.go`
- Modify: `backend/cmd/server/main.go:83` (add route after the existing worktree/project routes)
- Test: `backend/internal/service/project_test.go` (new file, or append if it already exists — check first with `ls backend/internal/service/project_test.go`)

**Interfaces:**
- Consumes: `git.ListBranches` (Task 1), `store.ProjectByID` (existing).
- Produces: `ProjectService.ListBranches(id string) ([]string, error)`, `ProjectHandler.GetProjectBranches(w http.ResponseWriter, r *http.Request)`, route `GET /api/projects/{id}/branches`.

- [ ] **Step 1: Write the failing test**

Check whether `backend/internal/service/project_test.go` exists (`ls backend/internal/service/`). If it doesn't, create it with this content; if it does, append the test function and reuse its existing imports/helpers instead of redeclaring them.

```go
package service

import (
	"path/filepath"
	"testing"

	"loom/backend/internal/store"
)

func TestProjectListBranchesReturnsRealBranches(t *testing.T) {
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
	repoPath := mustInitGitRepo(t)
	runGit(t, repoPath, "branch", "feat/x")

	proj, err := st.CreateProject(ws.ID, "core", repoPath, "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	branches, err := svc.ListBranches(proj.ID)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("ListBranches = %v, want 2 branches", branches)
	}
}
```

Note: `mustInitGitRepo` and `runGit` are already defined in `backend/internal/service/worktree_test.go` (added in Task 5) and are visible to this file since both are in package `service`. Do not redeclare them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/... -run TestProjectListBranches -v`
Expected: FAIL — `svc.ListBranches undefined`.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/internal/service/project.go`:

```go
// ListBranches returns the real git branches of a project's repository.
func (svc *ProjectService) ListBranches(id string) ([]string, error) {
	p, err := svc.store.ProjectByID(id)
	if err != nil {
		return nil, err
	}
	return gitpkg.ListBranches(p.Path)
}
```

Update the import block at the top of `backend/internal/service/project.go`:

```go
import (
	"strings"

	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)
```

Add to `backend/internal/handler/project.go` (after `DeleteProject`, before `func str`):

```go
// GetProjectBranches returns the real git branches of a project's repository.
func (h *ProjectHandler) GetProjectBranches(w http.ResponseWriter, r *http.Request) {
	branches, err := h.svc.ListBranches(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, branches)
}
```

Modify `backend/cmd/server/main.go` — add the new route right after the existing project routes (near what is currently line 78, `mux.HandleFunc("DELETE /api/projects/{id}", pH.DeleteProject)`):

```go
	mux.HandleFunc("POST /api/workspaces/{wsId}/projects", pH.PostProject)
	mux.HandleFunc("PATCH /api/projects/{id}", pH.PatchProject)
	mux.HandleFunc("DELETE /api/projects/{id}", pH.DeleteProject)
	mux.HandleFunc("GET /api/projects/{id}/branches", pH.GetProjectBranches)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./... -v`
Expected: PASS — full backend suite, including the new test.

- [ ] **Step 5: Checkpoint**

Run: `cd backend && go vet ./... && go build ./...`
Expected: no errors.

---

### Task 9: Frontend — `useProjectBranches` query hook

**Files:**
- Modify: `frontend/src/lib/api.ts` (Worktrees section, after `deleteWorktree`)
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: `GET /api/projects/{id}/branches` (Task 8), existing `request<T>` helper in `api.ts`.
- Produces: `fetchProjectBranches(id: string): Promise<string[]>`, `qk.projectBranches(id: string)`, `useProjectBranches(projectId: string | undefined)` returning a `UseQueryResult<string[]>`.

- [ ] **Step 1: Add the API client function**

In `frontend/src/lib/api.ts`, add after `deleteWorktree` (in the `// ---- Worktrees ----` section, currently ending at line 217):

```ts
export function fetchProjectBranches(id: string): Promise<string[]> {
  return request<string[]>('GET', `/projects/${id}/branches`)
}
```

- [ ] **Step 2: Add the query key**

In `frontend/src/features/data/keys.ts`, add to the `qk` object:

```ts
export const qk = {
  workspaces: ['workspaces'] as const,
  settings: ['settings'] as const,
  agents: ['agents'] as const,
  agentDetail: (id: string) => ['agents', id] as const,
  agentModels: (id: string) => ['agents', id, 'models'] as const,
  agentSkills: (id: string) => ['agents', id, 'skills'] as const,
  fsList: (path: string) => ['fs', 'list', path] as const,
  projectBranches: (id: string) => ['projects', id, 'branches'] as const,
}
```

- [ ] **Step 3: Add the query hook**

In `frontend/src/features/data/queries.ts`, add `fetchProjectBranches` to the import from `@/lib/api` (alphabetically, after `fetchFsList`):

```ts
  fetchFsList,
  fetchProjectBranches,
  fetchSettings,
```

Add the hook near `useFsList` (end of the "Filesystem" section, or right after `useAgentSkills` — either is fine, put it in a new `// ---- Projects ----` section right before `// ---- Filesystem ----`):

```ts
// ---- Projects ----

export function useProjectBranches(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.projectBranches(projectId ?? ''),
    queryFn: () => fetchProjectBranches(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  })
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (There's no unit test harness for query hooks in this codebase — Tasks 10-11 exercise this hook through the UI, and `npm run build` / manual verification at the end of the plan covers behavior.)

- [ ] **Step 5: Checkpoint**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

---

### Task 10: `SpawnDialog.tsx` — real Base branch dropdown

**Files:**
- Modify: `frontend/src/features/overlays/SpawnDialog.tsx`

**Interfaces:**
- Consumes: `useProjectBranches` (Task 9), existing `Select`/`SelectOption` from `@/components/ui/select`.

- [ ] **Step 1: Update imports and add the branches hook**

In `frontend/src/features/overlays/SpawnDialog.tsx`, change the React import (line 1) to include `useEffect`:

```ts
import { type ReactNode, useEffect, useState } from 'react'
```

Change the queries import (line 11) to include `useProjectBranches`:

```ts
import { useAgents, useAgentModels, useCreateWorktree, useProjectBranches, useWorkspaces } from '@/features/data/queries'
```

After the existing `project` lookup (line 22), add:

```ts
  const branches = useProjectBranches(project?.id).data ?? []
  const baseOptions = branches.map((b) => ({ value: b, label: b }))
```

- [ ] **Step 2: Keep `spawn.base` valid as branches load**

After the `branchMode` declaration (currently line 36), add:

```ts
  useEffect(() => {
    if (branchMode && branches.length > 0 && !branches.includes(spawn.base)) {
      setSpawn({ base: branches[0] })
    }
  }, [branchMode, branches, spawn.base, setSpawn])
```

- [ ] **Step 3: Replace the Base branch Input with a Select**

Replace the Base branch block (currently lines 115-119):

```tsx
        {branchMode && (
          <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Input value={spawn.base} onChange={(e) => setSpawn({ base: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="main" className="font-mono" />
          </div>
        )}
```

with:

```tsx
        {branchMode && (
          <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Select value={spawn.base} onValueChange={(v) => setSpawn({ base: v })} options={baseOptions} />
          </div>
        )}
```

- [ ] **Step 4: Verify it typechecks and builds**

Run: `cd frontend && npm run typecheck`
Expected: no errors. If `Input` is now unused in this file, TypeScript's `noUnusedLocals` (if enabled) will flag the import — remove `Input` from the import on line 7 only if the Branch-name field (which still uses `Input`, line 94-100) no longer needs it; check the file first, since Branch name stays free text and still uses `Input`, so the import should remain.

- [ ] **Step 5: Checkpoint**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

---

### Task 11: `EditDrawer.tsx` — real branch dropdown with running-state lock

**Files:**
- Modify: `frontend/src/components/ui/select.tsx` (add a `disabled` prop)
- Modify: `frontend/src/features/overlays/EditDrawer.tsx`

**Interfaces:**
- Consumes: `useProjectBranches` (Task 9), `projectOfWorktree`, `findWorktree` (existing, from `@/store/useLoomStore`).
- Produces: `Select` component gains an optional `disabled?: boolean` prop, usable by any future caller.

- [ ] **Step 1: Add a `disabled` prop to the shared Select component**

In `frontend/src/components/ui/select.tsx`, update `SelectProps` and the component:

```tsx
interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  className?: string
  triggerClassName?: string
  disabled?: boolean
  'aria-label'?: string
}

/** Thin wrapper over Base UI Select with the loom menu styling. */
export function Select({ value, onValueChange, options, className, triggerClassName, disabled, ...rest }: SelectProps) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={rest['aria-label']}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-loom-border-strong bg-loom-bg px-2.5',
          'font-mono text-xs text-loom-fg transition-colors select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:border-loom-border-accent',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          triggerClassName,
          className,
        )}
      >
```

(Leave the rest of the file — `BaseSelect.Value`, `BaseSelect.Icon`, `BaseSelect.Portal` and everything below it — unchanged.)

- [ ] **Step 2: Verify the `disabled` prop typechecks against Base UI**

Run: `cd frontend && npm run typecheck`
Expected: no errors. If TypeScript reports that `disabled` isn't a valid prop on `BaseSelect.Root`, move the `disabled={disabled}` line from `BaseSelect.Root` to `BaseSelect.Trigger` instead (Base UI form controls universally accept `disabled` on the trigger element even when the root doesn't) and re-run typecheck until it's clean.

- [ ] **Step 3: Wire the branch dropdown into EditDrawer**

In `frontend/src/features/overlays/EditDrawer.tsx`, update the queries import (line 13) to include `useProjectBranches`:

```ts
import { useAgents, useAgentModels, useProjectBranches, useUpdateProject, useUpdateWorkspace, useUpdateWorktree, useWorkspaces } from '@/features/data/queries'
```

Update the store import (line 14) to include `projectOfWorktree`:

```ts
import { findProject, findWorktree, findWs, projectOfWorktree, useLoomStore, wsOfProject } from '@/store/useLoomStore'
```

After the existing `modelOptions` block (currently lines 39-42), add:

```ts
  const editWorktree = edit.kind === 'worktree' && edit.id ? findWorktree(workspaces, edit.id) : null
  const editProjectId = edit.kind === 'worktree' && edit.id ? projectOfWorktree(workspaces, edit.id)?.id : undefined
  const branches = useProjectBranches(editProjectId).data ?? []
  const branchOptions = branches.map((b) => ({ value: b, label: b }))
  const branchLocked = editWorktree?.state === 'running' || editWorktree?.state === 'waiting'
```

- [ ] **Step 4: Replace the branch Input with a Select**

Replace the branch-name block inside `edit.kind === 'worktree'` (currently lines 121-126):

```tsx
                {!view.isRoot && (
                  <div className="mb-4">
                    <Label>Branch name</Label>
                    <Input value={edit.a} onChange={(e) => setEdit({ a: e.target.value })} className="font-mono" />
                  </div>
                )}
```

with:

```tsx
                {!view.isRoot && (
                  <div className="mb-4">
                    <Label>Branch name</Label>
                    <Select
                      value={edit.a}
                      onValueChange={(v) => setEdit({ a: v })}
                      options={branchOptions}
                      disabled={branchLocked}
                    />
                    {branchLocked && (
                      <div className="mt-1.5 font-mono text-[10.5px] text-loom-dim">pause to change branch</div>
                    )}
                  </div>
                )}
```

- [ ] **Step 5: Verify it typechecks**

Run: `cd frontend && npm run typecheck`
Expected: no errors. If `Input` becomes unused in this file, check whether the Project/Workspace name fields (lines 142, 146, 157) still use it — they do, so keep the import.

- [ ] **Step 6: Checkpoint**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both succeed, no errors.

---

## Final Verification

After all 11 tasks:

- [ ] Run `cd backend && go vet ./... && go build ./... && go test ./...` — expect all green.
- [ ] Run `cd frontend && npm run typecheck && npm run build` — expect all green.
- [ ] Manually verify with `/verify`-style exercise if a dev server is available: open the Spawn dialog for a project whose `path` points at a real local git repo, confirm the Base dropdown lists real branches, create a worktree, confirm a `.wt/<id>` directory actually appears on disk with the new branch checked out, then edit that worktree (after pausing it) and confirm changing its branch via the dropdown runs a real `git checkout`.
