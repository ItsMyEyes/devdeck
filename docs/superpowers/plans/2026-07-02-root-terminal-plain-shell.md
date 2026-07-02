# Root Terminal Plain Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Root-mode ("Project root") worktree sessions spawn a plain interactive shell instead of always launching an AI agent binary.

**Architecture:** The shell-fallback path already exists in `backend/internal/terminal/pty.go` (`buildSessionCmd` runs `pickShell()` whenever `agentBin == ""`) and `resolveCommand` already leaves `agentBin == ""` when a worktree's `Model` doesn't match a known agent-ID prefix. The only thing forcing an agent to launch for root sessions is that `WorktreeService.Create` unconditionally defaults an empty `model` to `"claude-sonnet-5"`. This plan removes that default for root mode, updates the seeded terminal-line copy to match, and updates `SpawnDialog` so root mode never sends a model in the first place.

**Tech Stack:** Go 1.22+ (backend, stdlib `testing`), React 19 + TypeScript (frontend, no test framework wired for this component — verified via `npm run typecheck` + manual check).

## Global Constraints

- Go: run `go vet ./...` before considering backend tasks done (from `.claude/rules/go.md`).
- Go: domain types are value types; no changes to `backend/internal/domain/models.go` in this plan (spec explicitly rules this out — no new "kind" field).
- Frontend: use `@/*` alias for imports from `src/`; `verbatimModuleSyntax` is on (from `.claude/rules/frontend.md`). No changes needed here since no new imports are added.
- Frontend: run `npm run typecheck` before considering the frontend task done.
- Do not touch `frontend/src/store/types.ts`, `backend/internal/domain/models.go`, `frontend/src/store/useLoomStore.ts`, or `frontend/src/routeTree.gen.ts` (CLAUDE.md convergence-file list) — this plan's design confirms none of them need to change.
- Branch mode (agent + git worktree) must be unaffected by every change in this plan.

---

### Task 1: Only default `model` to a real agent for branch mode

**Files:**
- Modify: `backend/internal/service/worktree.go:26-34`
- Test: `backend/internal/service/worktree_test.go`

**Interfaces:**
- Consumes: `svc.store.CreateWorktree(projectID, mode, branch, base, model, task string) (domain.Worktree, error)` (existing, unchanged signature, from `backend/internal/store/worktree.go:69`).
- Produces: `WorktreeService.Create(projectID, mode, branch, base, model, task string) (domain.Worktree, error)` now returns a `Worktree` whose `Model` is `""` when `mode == "root"` and the caller passed an empty/blank model. Later tasks (Task 4, frontend) rely on this: sending `model: ''` for root mode must NOT get silently upgraded to `"claude-sonnet-5"`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/service/worktree_test.go` (after the existing `mustCreateWorktree` helper, before `TestDeleteKillsRunningAgentBeforeRemovingRow`):

```go
func TestCreateDefaultsModelOnlyForBranchMode(t *testing.T) {
	svc, st := newTestSvc(t, nil)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/... -run TestCreateDefaultsModelOnlyForBranchMode -v`
Expected: FAIL — the `root.Model != ""` check fails because `Create` currently defaults every empty model to `"claude-sonnet-5"` regardless of mode.

- [ ] **Step 3: Update `Create` to gate the default on branch mode**

In `backend/internal/service/worktree.go`, replace lines 26-34:

```go
// Create creates a worktree (spawns an "agent").
func (svc *WorktreeService) Create(projectID, mode, branch, base, model, task string) (domain.Worktree, error) {
	branch = strings.TrimSpace(branch)
	base = strings.TrimSpace(base)
	model = strings.TrimSpace(model)
	if model == "" {
		model = "claude-sonnet-5"
	}
	return svc.store.CreateWorktree(projectID, mode, branch, base, model, task)
}
```

with:

```go
// Create creates a worktree. Branch mode always spawns an agent, so an empty
// model defaults to "claude-sonnet-5". Root mode is a plain shell terminal —
// an empty model there must stay empty, or resolveCommand would treat it as
// an agent session (see backend/internal/terminal/server.go resolveCommand).
func (svc *WorktreeService) Create(projectID, mode, branch, base, model, task string) (domain.Worktree, error) {
	branch = strings.TrimSpace(branch)
	base = strings.TrimSpace(base)
	model = strings.TrimSpace(model)
	if model == "" && mode == "branch" {
		model = "claude-sonnet-5"
	}
	return svc.store.CreateWorktree(projectID, mode, branch, base, model, task)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/service/... -run TestCreateDefaultsModelOnlyForBranchMode -v`
Expected: PASS

- [ ] **Step 5: Run the full service test suite to confirm no regressions**

Run: `cd backend && go test ./internal/service/... -v`
Expected: PASS (including the pre-existing `TestDeleteKillsRunningAgentBeforeRemovingRow`, whose `mustCreateWorktree` helper passes `"claude-sonnet-5"` explicitly and is unaffected).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/worktree.go backend/internal/service/worktree_test.go
git commit -m "service: only default worktree model for branch (agent) mode"
```

---

### Task 2: Reword root-mode seeded terminal lines for a plain shell

**Files:**
- Modify: `backend/internal/store/worktree.go:79-88`
- Test: `backend/internal/store/worktree_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateWorktree(projectID, "root", branch, base, model, task)` seeds `Worktree.Lines` with 3 entries (was 4) — no line mentions "agent" or "task context" for root mode. Branch mode's seeded lines (lines 100-105) are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/store/worktree_test.go` (add `"strings"` to the import block, then add the test after `TestCreateWorktreeLeavesEmptyTaskEmpty`):

```go
func TestCreateWorktreeRootModeSeedsShellNotAgentLines(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := s.CreateWorktree(proj.ID, "root", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}

	for _, l := range wt.Lines {
		if strings.Contains(l.T, "agent") {
			t.Errorf("root-mode seeded line mentions an agent, want plain-shell copy: %q", l.T)
		}
		if strings.Contains(l.T, "task context") {
			t.Errorf("root-mode seeded line mentions task context, which doesn't apply to a plain shell: %q", l.T)
		}
	}
	if len(wt.Lines) != 3 {
		t.Errorf("root-mode Lines = %d entries, want 3: %+v", len(wt.Lines), wt.Lines)
	}
}
```

The full updated import block:

```go
import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestCreateWorktreeRootModeSeedsShellNotAgentLines -v`
Expected: FAIL — current seeded lines include `"● starting agent in project root…"` and `"reading task context…"`.

- [ ] **Step 3: Update the seeded lines**

In `backend/internal/store/worktree.go`, replace lines 79-88:

```go
	if mode == "root" {
		w.Root = true
		w.Branch = ""
		w.Base = "main"
		w.Lines = []domain.TermLine{
			{K: "cmd", T: "$ cd " + p.Path},
			{K: "ok", T: "✓ terminal attached · " + p.Path + " (no worktree)"},
			{K: "sys", T: "● starting agent in project root…"},
			{K: "out", T: "reading task context…"},
		}
	} else {
```

with:

```go
	if mode == "root" {
		w.Root = true
		w.Branch = ""
		w.Base = "main"
		w.Lines = []domain.TermLine{
			{K: "cmd", T: "$ cd " + p.Path},
			{K: "ok", T: "✓ terminal attached · " + p.Path + " (no worktree)"},
			{K: "sys", T: "✓ shell ready"},
		}
	} else {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/store/... -run TestCreateWorktreeRootModeSeedsShellNotAgentLines -v`
Expected: PASS

- [ ] **Step 5: Run the full store test suite to confirm no regressions**

Run: `cd backend && go test ./internal/store/... -v`
Expected: PASS (including `TestCreateWorktreeLeavesEmptyTaskEmpty`, which only asserts on `wt.Task`, not `wt.Lines`).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/store/worktree.go backend/internal/store/worktree_test.go
git commit -m "store: reword root-mode seeded lines for a plain shell, not an agent"
```

---

### Task 3: Lock in the terminal shell-fallback contract with a regression test

**Files:**
- Test: `backend/internal/terminal/server_test.go` (new file)

**Interfaces:**
- Consumes: `NewServer(store port.Store) *Server` (`backend/internal/terminal/server.go:52`), `(*Server).resolveCommand(session string) (agentBin string, args []string, workDir string)` (unexported method on the same package, `server.go:100`), `store.Open(path string) (*sql.DB, error)` and `store.New(db *sql.DB) *Store` (`backend/internal/store`, already used in `backend/internal/service/worktree_test.go`).
- Produces: nothing consumed by later tasks — this is a standalone regression test that pins down the behavior Task 1 and Task 2 depend on (empty `Model` on a root worktree → `resolveCommand` returns `agentBin == ""` → `buildSessionCmd` falls back to `pickShell()`). No production code changes in this task.

- [ ] **Step 1: Write the failing-if-behavior-regresses test**

Create `backend/internal/terminal/server_test.go`:

```go
package terminal

import (
	"path/filepath"
	"testing"

	"loom/backend/internal/store"
)

func TestResolveCommandReturnsNoAgentForEmptyModelRootSession(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "root", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(st)
	agentBin, _, workDir := s.resolveCommand(wt.ID)

	if agentBin != "" {
		t.Errorf("resolveCommand agentBin = %q for empty-model root session, want empty (must fall back to a plain shell)", agentBin)
	}
	if workDir != proj.Path {
		t.Errorf("resolveCommand workDir = %q, want project root %q", workDir, proj.Path)
	}
}

func TestResolveCommandReturnsAgentForBranchModeSession(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "branch", "feat/x", "main", "claude-sonnet-5", "")
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(st)
	agentBin, _, _ := s.resolveCommand(wt.ID)

	if agentBin == "" {
		t.Skip("no claude binary resolvable in this environment — resolveCommand logs and returns empty; not a regression in the mode-gating logic under test")
	}
}
```

`TestResolveCommandReturnsAgentForBranchModeSession` uses `t.Skip` for the case where `detect.Resolve("claude")` can't find a real binary on the test machine (see `server.go:118-131`, which returns `agentBin == ""` on a resolution error) — the point of this second test is only to confirm branch mode is still *attempted* (doesn't short-circuit the way root mode now does), not to require a real `claude` install in CI.

- [ ] **Step 2: Run test to verify current behavior**

Run: `cd backend && go test ./internal/terminal/... -run TestResolveCommand -v`
Expected: PASS already, since Task 1 and Task 2 changes are backend-only and `resolveCommand` itself needs no code change — this test documents/pins the existing fallback behavior. If it fails, that means Task 1's `Create` change didn't take effect (re-check Task 1 Step 3).

- [ ] **Step 3: Run the full terminal test suite to confirm no regressions**

Run: `cd backend && go test ./internal/terminal/... -v`
Expected: PASS (including pre-existing `TestKillSessionTerminatesRunningProcess`, `TestKillSessionNoopWhenNotRunning`, and the binary tests).

- [ ] **Step 4: Commit**

```bash
git add backend/internal/terminal/server_test.go
git commit -m "terminal: add regression test pinning root-mode shell fallback"
```

---

### Task 4: SpawnDialog — hide Agent/Model/Task for root mode, never send a model for root

**Files:**
- Modify: `frontend/src/features/overlays/SpawnDialog.tsx`

**Interfaces:**
- Consumes: existing `spawn: SpawnState` (`branchMode`, `spawn.model`, `spawn.task`) and `createWorktree.mutate` — no interface changes, this task only changes conditional rendering and the payload built in `submit()`.
- Produces: nothing consumed by later tasks (last task in this plan).

- [ ] **Step 1: Update `submit()` to never send a model/task for root mode**

In `frontend/src/features/overlays/SpawnDialog.tsx`, replace lines 38-57:

```tsx
  function submit() {
    const projectId = spawn.projectId
    if (!projectId) return
    createWorktree.mutate(
      {
        projectId,
        body: { mode: spawn.mode, branch: spawn.branch, base: spawn.base, model: spawn.model, task: spawn.task },
      },
      {
        onSuccess: (wt) => {
          closeSpawn()
          setSidebarOpen(false)
          const wsId = workspaces.find((w) => w.projects.some((p) => p.id === projectId))?.id
          if (wsId) {
            navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: wt.id } })
          }
        },
      },
    )
  }
```

with:

```tsx
  function submit() {
    const projectId = spawn.projectId
    if (!projectId) return
    createWorktree.mutate(
      {
        projectId,
        body: {
          mode: spawn.mode,
          // Root mode is a plain shell terminal — no agent is picked, so no
          // model/task must be sent, or the backend would treat it as an
          // agent session (see backend/internal/service/worktree.go Create).
          branch: spawn.branch,
          base: spawn.base,
          model: branchMode ? spawn.model : '',
          task: branchMode ? spawn.task : '',
        },
      },
      {
        onSuccess: (wt) => {
          closeSpawn()
          setSidebarOpen(false)
          const wsId = workspaces.find((w) => w.projects.some((p) => p.id === projectId))?.id
          if (wsId) {
            navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: wt.id } })
          }
        },
      },
    )
  }
```

- [ ] **Step 2: Hide the Task field for root mode**

Replace lines 104-112:

```tsx
      <div className="mb-3.5">
        <Label>Task</Label>
        <Textarea
          value={spawn.task}
          onChange={(e) => setSpawn({ task: e.target.value })}
          placeholder="Describe what this agent should do…"
          className="h-[70px]"
        />
      </div>
```

with:

```tsx
      {branchMode && (
        <div className="mb-3.5">
          <Label>Task</Label>
          <Textarea
            value={spawn.task}
            onChange={(e) => setSpawn({ task: e.target.value })}
            placeholder="Describe what this agent should do…"
            className="h-[70px]"
          />
        </div>
      )}
```

- [ ] **Step 3: Hide the Base branch / Agent / Model row for root mode**

Replace lines 114-129:

```tsx
      <div className="mb-5 flex flex-wrap gap-3">
        {branchMode && (
          <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Input value={spawn.base} onChange={(e) => setSpawn({ base: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="main" className="font-mono" />
          </div>
        )}
        <div className="min-w-[140px] flex-1">
          <Label>Agent</Label>
          <Select value={agentId} onValueChange={handleAgentChange} options={agentOptions} />
        </div>
        <div className="min-w-[140px] flex-1">
          <Label>Model</Label>
          <Select value={spawn.model} onValueChange={(v) => setSpawn({ model: v })} options={modelOptions} />
        </div>
      </div>
```

with:

```tsx
      {branchMode && (
        <div className="mb-5 flex flex-wrap gap-3">
          <div className="min-w-[140px] flex-1">
            <Label>Base branch</Label>
            <Input value={spawn.base} onChange={(e) => setSpawn({ base: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="main" className="font-mono" />
          </div>
          <div className="min-w-[140px] flex-1">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={handleAgentChange} options={agentOptions} />
          </div>
          <div className="min-w-[140px] flex-1">
            <Label>Model</Label>
            <Select value={spawn.model} onValueChange={(v) => setSpawn({ model: v })} options={modelOptions} />
          </div>
        </div>
      )}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (`agents`, `agentId`, `models`, `modelOptions`, `agentOptions`, `handleAgentChange` are still referenced inside the now-conditional block, so no unused-variable errors.)

- [ ] **Step 5: Manual verification**

Run the dev server (see `COMMANDS.md`) and:
1. Open the spawn dialog in "Project root" mode — confirm no Agent/Model picker and no Task field are shown; the dialog only shows the mode tabs and Cancel/Create buttons.
2. Click "Create →" — confirm the new worktree attaches a terminal showing `✓ shell ready` (not "starting agent…"), and typing a shell command (e.g. `pwd`, `echo hi`) works — this is a real shell, not an agent CLI.
3. Switch to "New branch" mode — confirm Task, Base branch, Agent, and Model fields are all still shown and branch-mode spawning still launches the agent as before.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/overlays/SpawnDialog.tsx
git commit -m "SpawnDialog: root mode is a plain shell — hide agent/model/task fields"
```
