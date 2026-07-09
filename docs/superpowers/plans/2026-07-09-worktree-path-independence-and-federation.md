# Worktree Path Independence + Hub Federation Implementation Plan (Sub-project #1.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

Sub-project #2's end-to-end verification (`docs/superpowers/plans/2026-07-09-frontend-multi-machine-client.md`) uncovered a real architecture gap, confirmed independently against the code (not just the verifying agent's report):

1. **Runtime worktree operations 404.** `WorktreeService.Create` (branch AND root mode, via `store.CreateWorktree`), `Update`, `Delete`, every worktree-file operation (`worktree_file.go`'s `worktreeRoot()`), and every worktree-git operation (`worktree_git.go`'s `root()`) all resolve a worktree's on-disk directory as `project.Path` (+`.wt/`+id) by calling `store.ProjectByID(worktree.ProjectID)`. A runtime never has a local `projects` row for a hub-owned project (projects are hub-scoped organizational data), so every one of these calls fails with "not found." The `worktrees.project_id` column is also `NOT NULL REFERENCES projects(id) ON DELETE CASCADE` with `foreign_keys` pragma on — so even fixing the application-code lookups wouldn't be enough; SQLite itself would reject inserting a worktree row with no matching local project.

2. **Even if (1) is fixed, worktrees created on a runtime are invisible to the hub.** `GET /workspaces` (`store.Workspaces()` → `projectsOf()` → `worktreesOf()`) only ever reads the hub's own local `worktrees` table. Since worktree rows physically live on whichever runtime executed the create, the hub's nested tree — which the entire frontend reads via a single `useWorkspace(wsId)` call — would show zero worktrees for any remote-machine project, forever.

**Decisions made for this fix (confirmed with the operator):**
- The runtime becomes fully independent of local project rows: worktree creation and branch listing take the repo `path` directly (the frontend already has it, from the hub's project record), not a project-ID lookup. This matches the "runtime is a pure execution daemon" model — no project/workspace concept needed there at all.
- The hub closes the federation gap **server-side**: `GET /workspaces` fetches each machine-assigned project's live worktrees from its runtime (direct server-to-server call, since hub and runtimes share one tailnet) and merges them into the response before returning to the client. This requires **zero frontend changes** for the tree-reading side — `useWorkspace`/`useWorkspaces` keep working exactly as built in sub-project #2. Unreachable machines degrade gracefully (that project's worktrees show as unknown/empty, not an error for the whole request).

**Goal:** Worktree create/update/delete/files/git work on a runtime with no local project row. The hub's workspace tree shows real, live worktree data for every machine-assigned project.

**Tech stack:** Go, `modernc.org/sqlite` (schema rebuild migration — SQLite can't ALTER a column's constraints in place), `net/http` (new minimal hub→runtime server-to-server client), goroutines + `sync.WaitGroup` for bounded concurrent federation fetches.

## Global Constraints

- Same constraints as the two prior plans: `{"error":"message"}` envelope, `port.Store` only, `?` placeholders, `handleStoreErr()`, `go vet ./...` before commits, `@/*` frontend imports, `import type` for type-only imports, this repo's pre-commit hook hard-fails any commit where `cd frontend && npm run typecheck` errors — every commit in this plan must leave typecheck clean.
- Work continues directly on branch `feat/frontend-multi-machine` (already has `machineApi.ts`, `SpawnDialog.tsx`, etc. from sub-project #2 — this fix depends on those files existing). Do not create a new branch.
- `domain.Worktree.Path` is backend-internal (`json:"-"`), mirroring `ProjectID` — it is never exposed to or needed by the frontend, which already has the project's path from its own hub-side project record.

---

### Task 1: Schema — `worktrees.path` column, drop the `project_id` foreign key

**Files:**
- Modify: `backend/internal/store/db.go`
- Modify: `backend/internal/domain/models.go`
- Test: `backend/internal/store/worktree_test.go` (extend), new `backend/internal/store/db_migration_test.go`

**Interfaces (produced):**
- `domain.Worktree` gains `Path string \`json:"-"\`` (the resolved absolute repo-root path — for a root-mode worktree this IS the checkout; for branch mode the checkout is still `filepath.Join(Path, ".wt", ID)`).
- Schema: `worktrees.path TEXT NOT NULL DEFAULT ''`; the `project_id` column loses its `REFERENCES projects(id) ON DELETE CASCADE` clause (stays `TEXT NOT NULL`, just no longer FK-enforced).

- [ ] **Step 1: Write failing test.** In `backend/internal/store/worktree_test.go`, add:

  ```go
  func TestWorktreeInsertWithUnknownProjectIDSucceeds(t *testing.T) {
  	s := newTestStore(t)
  	// No workspace/project created at all — this project_id matches nothing
  	// locally, simulating a runtime that has never heard of this project.
  	w, err := s.CreateWorktree("p-doesnotexist", "root", "", "main", "", "", "", "/tmp/some/repo")
  	if err != nil {
  		t.Fatalf("CreateWorktree with unknown project_id should succeed (no local FK): %v", err)
  	}
  	if w.Path != "/tmp/some/repo" {
  		t.Errorf("Path = %q, want /tmp/some/repo", w.Path)
  	}
  }
  ```

  (This anticipates `CreateWorktree` gaining a trailing `path` parameter — Task 1 Step 3 changes its signature.)

- [ ] **Step 2:** `cd backend && go test ./internal/store/ -run TestWorktreeInsertWithUnknownProjectIDSucceeds -v` → FAIL (compile error: too many arguments / FK violation once signature matches).

- [ ] **Step 3: Schema changes in `db.go`.** Change the `worktrees` table definition from:

  ```sql
  CREATE TABLE IF NOT EXISTS worktrees (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    root       INTEGER NOT NULL DEFAULT 0,
    branch     TEXT NOT NULL DEFAULT '',
    base       TEXT NOT NULL DEFAULT 'main',
    ahead      INTEGER NOT NULL DEFAULT 0,
    behind     INTEGER NOT NULL DEFAULT 0,
    model      TEXT NOT NULL DEFAULT '',
    agent      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'running',
    task       TEXT NOT NULL DEFAULT '',
    tokens     INTEGER NOT NULL DEFAULT 0,
    elapsed    INTEGER NOT NULL DEFAULT 0,
    added      INTEGER NOT NULL DEFAULT 0,
    removed    INTEGER NOT NULL DEFAULT 0,
    files      INTEGER NOT NULL DEFAULT 0,
    lines      TEXT NOT NULL DEFAULT '[]',
    pending    TEXT
  );
  ```

  to (drop the `REFERENCES ... ON DELETE CASCADE` clause on `project_id`; this only affects **fresh** databases — existing ones are migrated in Step 4):

  ```sql
  CREATE TABLE IF NOT EXISTS worktrees (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    root       INTEGER NOT NULL DEFAULT 0,
    branch     TEXT NOT NULL DEFAULT '',
    base       TEXT NOT NULL DEFAULT 'main',
    ahead      INTEGER NOT NULL DEFAULT 0,
    behind     INTEGER NOT NULL DEFAULT 0,
    model      TEXT NOT NULL DEFAULT '',
    agent      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'running',
    task       TEXT NOT NULL DEFAULT '',
    tokens     INTEGER NOT NULL DEFAULT 0,
    elapsed    INTEGER NOT NULL DEFAULT 0,
    added      INTEGER NOT NULL DEFAULT 0,
    removed    INTEGER NOT NULL DEFAULT 0,
    files      INTEGER NOT NULL DEFAULT 0,
    lines      TEXT NOT NULL DEFAULT '[]',
    pending    TEXT,
    path       TEXT NOT NULL DEFAULT ''
  );
  ```

  A brand-new database now gets the right schema via `CREATE TABLE IF NOT EXISTS` directly. Existing databases (created before this change) still have the old FK — Step 4 migrates them.

- [ ] **Step 4: Migration for existing databases.** Add, called from `Open()` alongside the other `migrate*` calls (after `migrateWorktreeColumns`):

  ```go
  // migrateWorktreeIndependence adds worktrees.path (backfilling it from the
  // owning project's path where one still exists locally) and rebuilds the
  // worktrees table without the project_id foreign key, so a runtime can hold
  // worktree rows whose project lives only on the hub. SQLite can't ALTER a
  // column's constraints in place, hence the rename-recreate-copy-drop dance.
  // Idempotent: skipped if the table's stored SQL no longer references
  // projects(id).
  func migrateWorktreeIndependence(db *sql.DB) error {
  	if _, err := db.Exec("ALTER TABLE worktrees ADD COLUMN path TEXT NOT NULL DEFAULT ''"); err != nil {
  		if !strings.Contains(err.Error(), "duplicate column name") {
  			return err
  		}
  	}

  	var createSQL string
  	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'`).Scan(&createSQL)
  	if err != nil {
  		return err
  	}
  	if !strings.Contains(createSQL, "REFERENCES projects") {
  		return nil // already migrated
  	}

  	// Backfill path from the still-locally-joinable project, for any
  	// pre-existing worktree row that predates this migration.
  	if _, err := db.Exec(`
  		UPDATE worktrees SET path = (SELECT path FROM projects WHERE projects.id = worktrees.project_id)
  		WHERE path = '' AND EXISTS (SELECT 1 FROM projects WHERE projects.id = worktrees.project_id)
  	`); err != nil {
  		return err
  	}

  	tx, err := db.Begin()
  	if err != nil {
  		return err
  	}
  	defer tx.Rollback()

  	if _, err := tx.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
  		return err
  	}
  	if _, err := tx.Exec(`ALTER TABLE worktrees RENAME TO worktrees_old_fk`); err != nil {
  		return err
  	}
  	if _, err := tx.Exec(`
  		CREATE TABLE worktrees (
  		  id         TEXT PRIMARY KEY,
  		  project_id TEXT NOT NULL,
  		  root       INTEGER NOT NULL DEFAULT 0,
  		  branch     TEXT NOT NULL DEFAULT '',
  		  base       TEXT NOT NULL DEFAULT 'main',
  		  ahead      INTEGER NOT NULL DEFAULT 0,
  		  behind     INTEGER NOT NULL DEFAULT 0,
  		  model      TEXT NOT NULL DEFAULT '',
  		  agent      TEXT NOT NULL DEFAULT '',
  		  state      TEXT NOT NULL DEFAULT 'running',
  		  task       TEXT NOT NULL DEFAULT '',
  		  tokens     INTEGER NOT NULL DEFAULT 0,
  		  elapsed    INTEGER NOT NULL DEFAULT 0,
  		  added      INTEGER NOT NULL DEFAULT 0,
  		  removed    INTEGER NOT NULL DEFAULT 0,
  		  files      INTEGER NOT NULL DEFAULT 0,
  		  lines      TEXT NOT NULL DEFAULT '[]',
  		  pending    TEXT,
  		  path       TEXT NOT NULL DEFAULT ''
  		)
  	`); err != nil {
  		return err
  	}
  	if _, err := tx.Exec(`
  		INSERT INTO worktrees (id, project_id, root, branch, base, ahead, behind, model, agent,
  		                        state, task, tokens, elapsed, added, removed, files, lines, pending, path)
  		SELECT id, project_id, root, branch, base, ahead, behind, model, agent,
  		       state, task, tokens, elapsed, added, removed, files, lines, pending, path
  		FROM worktrees_old_fk
  	`); err != nil {
  		return err
  	}
  	if _, err := tx.Exec(`DROP TABLE worktrees_old_fk`); err != nil {
  		return err
  	}
  	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id)`); err != nil {
  		return err
  	}
  	if err := tx.Commit(); err != nil {
  		return err
  	}
  	_, err = db.Exec(`PRAGMA foreign_keys = ON`)
  	return err
  }
  ```

  Wire it into `Open()` right after the `migrateWorktreeColumns` call:

  ```go
  if err := migrateWorktreeIndependence(db); err != nil {
  	db.Close()
  	return nil, err
  }
  ```

- [ ] **Step 5: `domain.Worktree` gains `Path`.** In `backend/internal/domain/models.go`, add `Path string \`json:"-"\`` to the `Worktree` struct, next to `ProjectID`.

- [ ] **Step 6: Thread `path` through the store layer.** In `backend/internal/store/worktree.go`:
  - `scanWorktree`'s `SELECT`/`Scan` column list (in `worktreesOf`, `WorktreeByID`, and anywhere else scanning a worktree row) gains `path` at the end, scanned into `&w.Path`.
  - `CreateWorktree(projectID, mode, branch, base, model, agent, task string)` gains a trailing `path string` parameter → `CreateWorktree(projectID, mode, branch, base, model, agent, task, path string)`. Remove its internal `p, err := s.ProjectByID(projectID)` call entirely; use the passed-in `path` wherever `p.Path` was used (the seeded `Lines` text). Store `path` on the inserted row (`w.Path = path`, included in the `INSERT` column list).
  - Add a new exported method (thin wrapper over the existing private `worktreesOf`, used by Task 3's new list endpoint):
    ```go
    // WorktreesByProjectID lists a project's worktrees. Used by the runtime's
    // list endpoint that the hub calls to federate live worktree data into
    // its workspace tree (see service/workspace.go).
    func (s *Store) WorktreesByProjectID(projectID string) ([]domain.Worktree, error) {
    	return s.worktreesOf(projectID)
    }
    ```

- [ ] **Step 7: `port.Store` interface + `port.CreateWorktree` signature.** Update `backend/internal/port/store.go`'s `Store` interface: `CreateWorktree(projectID, mode, branch, base, model, agent, task, path string) (domain.Worktree, error)` and add `WorktreesByProjectID(projectID string) ([]domain.Worktree, error)`.

- [ ] **Step 8: Verify.**

  ```bash
  cd backend && go build ./... 2>&1 | head -40
  ```

  Expected: compile errors in `service/worktree.go` (call sites of `CreateWorktree` missing the new `path` arg) — that's Task 2's job. Confirm errors are confined to the service package.

  ```bash
  go test ./internal/store/ -run TestWorktreeInsertWithUnknownProjectIDSucceeds -v
  go test ./internal/store/ -run TestCreateWorktree -v   # existing tests must still pass with the extra param added at call sites — fix any that don't compile
  ```

  You will need to add `""` (or a real path) as the trailing argument to every pre-existing `CreateWorktree(...)` call in test files (`worktree_test.go` and any other `_test.go` calling it directly) for the package to compile — do this now so `go test ./internal/store/...` is fully green before moving on.

- [ ] **Step 9: Commit.**

  ```bash
  git add backend/internal/store/db.go backend/internal/store/worktree.go backend/internal/store/worktree_test.go \
    backend/internal/domain/models.go backend/internal/port/store.go
  git commit -m "$(cat <<'EOF'
  feat(worktrees): drop project_id FK, add path column so runtimes don't need a local project row

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Service layer — remove `ProjectByID` from every worktree path-resolution call site

**Files:**
- Modify: `backend/internal/service/worktree.go`
- Modify: `backend/internal/service/worktree_file.go`
- Modify: `backend/internal/service/worktree_git.go`

**Interfaces (changed):** `WorktreeService.Create(projectID, path, mode, branch, base, model, agent, task string) (domain.Worktree, error)` — `path` inserted as the 2nd parameter (right after `projectID`, since it's the identity-adjacent piece of data the caller must supply instead of what used to be resolved via lookup).

- [ ] **Step 1: `worktree.go` — `Create`.** Change the signature and body from:

  ```go
  func (svc *WorktreeService) Create(projectID, mode, branch, base, model, agent, task string) (domain.Worktree, error) {
  	branch = strings.TrimSpace(branch)
  	base = strings.TrimSpace(base)
  	model = strings.TrimSpace(model)
  	agent = strings.TrimSpace(agent)
  	if mode == "branch" {
  		if model == "" {
  			model = "claude-sonnet-5"
  		}
  		if agent == "" {
  			agent = "claude"
  		}
  	}
  	if mode != "branch" {
  		return svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task)
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

  	wt, err := svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task)
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
  ```

  to:

  ```go
  func (svc *WorktreeService) Create(projectID, path, mode, branch, base, model, agent, task string) (domain.Worktree, error) {
  	branch = strings.TrimSpace(branch)
  	base = strings.TrimSpace(base)
  	model = strings.TrimSpace(model)
  	agent = strings.TrimSpace(agent)
  	path = gitpkg.ExpandHome(strings.TrimSpace(path))
  	if mode == "branch" {
  		if model == "" {
  			model = "claude-sonnet-5"
  		}
  		if agent == "" {
  			agent = "claude"
  		}
  	}
  	if mode != "branch" {
  		return svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task, path)
  	}

  	if base == "" {
  		base = "main"
  	}
  	branches, err := gitpkg.ListBranches(path)
  	if err != nil {
  		return domain.Worktree{}, fmt.Errorf("list branches: %w", err)
  	}
  	if !containsStr(branches, base) {
  		return domain.Worktree{}, fmt.Errorf("base branch %q not found in repository: %w", base, ErrValidation)
  	}
  	if branch != "" {
  		siblings, err := svc.store.WorktreesByProjectID(projectID)
  		if err != nil {
  			return domain.Worktree{}, err
  		}
  		for _, w := range siblings {
  			if w.Branch == branch {
  				return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", branch, ErrConflict)
  			}
  		}
  	}

  	wt, err := svc.store.CreateWorktree(projectID, mode, branch, base, model, agent, task, path)
  	if err != nil {
  		return domain.Worktree{}, err
  	}

  	worktreePath := filepath.Join(path, ".wt", wt.ID)
  	if err := gitpkg.AddWorktree(path, worktreePath, wt.Branch, base); err != nil {
  		_ = svc.store.DeleteWorktree(wt.ID)
  		return domain.Worktree{}, fmt.Errorf("git worktree add: %w", err)
  	}
  	return wt, nil
  }
  ```

  (The sibling-branch-conflict check now queries the runtime's own local `worktrees` table via the new `WorktreesByProjectID` — this works with zero local project data, since it's a plain `WHERE project_id = ?` scan, no FK/join needed.)

- [ ] **Step 2: `worktree.go` — `Update`.** Change:

  ```go
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
  ```

  to:

  ```go
  			siblings, err := svc.store.WorktreesByProjectID(wt.ProjectID)
  			if err != nil {
  				return domain.Worktree{}, err
  			}
  			for _, sibling := range siblings {
  				if sibling.ID != id && sibling.Branch == newBranch {
  					return domain.Worktree{}, fmt.Errorf("branch %q is already checked out by another worktree: %w", newBranch, ErrConflict)
  				}
  			}
  			worktreePath := wt.Path
  			if !wt.Root {
  				worktreePath = filepath.Join(wt.Path, ".wt", id)
  			}
  ```

- [ ] **Step 3: `worktree.go` — `Delete`.** Change:

  ```go
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
  ```

  to:

  ```go
  	if !wt.Root {
  		worktreePath := filepath.Join(wt.Path, ".wt", id)
  		if err := gitpkg.RemoveWorktree(wt.Path, worktreePath); err != nil {
  			return fmt.Errorf("git worktree remove: %w", err)
  		}
  	}
  ```

- [ ] **Step 4: `worktree_file.go` — `worktreeRoot`.** Change:

  ```go
  func (svc *WorktreeFileService) worktreeRoot(worktreeID string) (string, error) {
  	worktree, err := svc.store.WorktreeByID(worktreeID)
  	if err != nil {
  		return "", err
  	}
  	project, err := svc.store.ProjectByID(worktree.ProjectID)
  	if err != nil {
  		return "", err
  	}
  	projectRoot := gitpkg.ExpandHome(project.Path)
  	if worktree.Root {
  		return projectRoot, nil
  	}
  	return filepath.Join(projectRoot, ".wt", worktreeID), nil
  }
  ```

  to:

  ```go
  func (svc *WorktreeFileService) worktreeRoot(worktreeID string) (string, error) {
  	worktree, err := svc.store.WorktreeByID(worktreeID)
  	if err != nil {
  		return "", err
  	}
  	projectRoot := gitpkg.ExpandHome(worktree.Path)
  	if worktree.Root {
  		return projectRoot, nil
  	}
  	return filepath.Join(projectRoot, ".wt", worktreeID), nil
  }
  ```

- [ ] **Step 5: `worktree_git.go` — `root`.** Apply the identical change (same before/after shape as Step 4, just in this file's `root(worktreeID string) (string, error)` function).

- [ ] **Step 6: Update the two call sites of `WorktreeService.Create`.** `backend/internal/handler/worktree.go`'s `PostWorktree` is the only production call site — Task 3 updates it (it needs the new `path` field from the request body anyway). Any test file directly calling `WorktreeService.Create(...)` needs its argument list updated to insert a `path` string as the 2nd argument — find them via `grep -rn "\.Create(" backend/internal/service/*_test.go backend/internal/handler/*_test.go` and update each to pass a real temp-dir path (tests likely already set up a temp git repo directory for this purpose — reuse whatever path variable the test already uses for `svc.store.CreateWorktree`/project creation).

- [ ] **Step 7: Verify.**

  ```bash
  cd backend && go build ./... 2>&1 | head -40
  ```

  Expected: remaining errors only in `handler/worktree.go` (Task 3) and possibly `handler/project.go` (branches, also Task 3).

  ```bash
  go test ./internal/service/ -v
  ```

  Fix any test compile errors per Step 6, then confirm all pass.

- [ ] **Step 8: Commit.**

  ```bash
  git add backend/internal/service/worktree.go backend/internal/service/worktree_file.go \
    backend/internal/service/worktree_git.go backend/internal/service/*_test.go
  git commit -m "$(cat <<'EOF'
  feat(worktrees): resolve on-disk path from the worktree row, not a project lookup

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Handlers/routes — accept `path`, add the runtime's worktree-list endpoint

**Files:**
- Modify: `backend/internal/handler/worktree.go`
- Modify: `backend/internal/handler/project.go`
- Modify: `backend/internal/service/project.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces (changed/produced):**
- `POST /api/projects/{projectId}/worktrees` body gains a required `path` field.
- `GET /api/projects/{id}/branches` gains a required `path` query param, used instead of a project lookup.
- New: `GET /api/projects/{projectId}/worktrees` → `WorktreeHandler.ListWorktrees` → `WorktreeService.ListByProject(projectID) ([]domain.Worktree, error)` → `store.WorktreesByProjectID`. Registered on all roles (harmless on hub; this is what the hub's federation client in Task 4 calls on a runtime).

- [ ] **Step 1: `handler/worktree.go` — `PostWorktree` takes `path`.** Change:

  ```go
  var body struct {
  	Mode   string  `json:"mode"`
  	Branch *string `json:"branch"`
  	Base   *string `json:"base"`
  	Model  string  `json:"model"`
  	Agent  string  `json:"agent"`
  	Task   *string `json:"task"`
  }
  ...
  wt, err := h.svc.Create(r.PathValue("projectId"), body.Mode, str(body.Branch), str(body.Base), body.Model, body.Agent, str(body.Task))
  ```

  to:

  ```go
  var body struct {
  	Mode   string  `json:"mode"`
  	Branch *string `json:"branch"`
  	Base   *string `json:"base"`
  	Model  string  `json:"model"`
  	Agent  string  `json:"agent"`
  	Task   *string `json:"task"`
  	Path   string  `json:"path"`
  }
  if _, err := decodeBody(r, &body); err != nil {
  	writeErr(w, http.StatusBadRequest, "invalid body")
  	return
  }
  if body.Path == "" {
  	writeErr(w, http.StatusBadRequest, "path is required")
  	return
  }
  ...
  wt, err := h.svc.Create(r.PathValue("projectId"), body.Path, body.Mode, str(body.Branch), str(body.Base), body.Model, body.Agent, str(body.Task))
  ```

  (Match whatever the existing `decodeBody`/validation ordering looks like exactly — read the current file first; this shows the net change, not necessarily the exact surrounding line positions.)

- [ ] **Step 2: Add `ListWorktrees` to `handler/worktree.go`.**

  ```go
  // ListWorktrees returns a project's worktrees. Called by the hub to
  // federate live worktree data from the runtime that owns the project (see
  // service/workspace.go); harmless to expose on any role.
  func (h *WorktreeHandler) ListWorktrees(w http.ResponseWriter, r *http.Request) {
  	list, err := h.svc.ListByProject(r.PathValue("projectId"))
  	if handleStoreErr(w, err) {
  		return
  	}
  	writeJSON(w, http.StatusOK, list)
  }
  ```

  Add `ListByProject` to `WorktreeService` in `backend/internal/service/worktree.go`:

  ```go
  // ListByProject returns a project's worktrees from local storage.
  func (svc *WorktreeService) ListByProject(projectID string) ([]domain.Worktree, error) {
  	return svc.store.WorktreesByProjectID(projectID)
  }
  ```

- [ ] **Step 3: `service/project.go` — `ListBranches` takes `path` directly.** Change:

  ```go
  func (svc *ProjectService) ListBranches(id string) ([]string, error) {
  	p, err := svc.store.ProjectByID(id)
  	if err != nil {
  		return nil, err
  	}
  	return gitpkg.ListBranches(p.Path)
  }
  ```

  to:

  ```go
  func (svc *ProjectService) ListBranches(path string) ([]string, error) {
  	return gitpkg.ListBranches(gitpkg.ExpandHome(path))
  }
  ```

  (`gitpkg` must already be imported in this file — confirm, it's used elsewhere in the same package already per Task 2's reasoning; if not imported here yet, add `gitpkg "loom/backend/internal/git"`.)

- [ ] **Step 4: `handler/project.go` — `GetProjectBranches` takes `?path=`.** Change:

  ```go
  func (h *ProjectHandler) GetProjectBranches(w http.ResponseWriter, r *http.Request) {
  	branches, err := h.svc.ListBranches(r.PathValue("id"))
  	if handleStoreErr(w, err) {
  		return
  	}
  	writeJSON(w, http.StatusOK, branches)
  }
  ```

  to:

  ```go
  func (h *ProjectHandler) GetProjectBranches(w http.ResponseWriter, r *http.Request) {
  	path := r.URL.Query().Get("path")
  	if path == "" {
  		writeErr(w, http.StatusBadRequest, "path is required")
  		return
  	}
  	branches, err := h.svc.ListBranches(path)
  	if handleStoreErr(w, err) {
  		return
  	}
  	writeJSON(w, http.StatusOK, branches)
  }
  ```

  (The `{id}` URL segment is kept for route stability/logging even though it's now unused by the handler body — harmless.)

- [ ] **Step 5: Register the new route in `main.go`.** Add, right next to the existing `POST /api/projects/{projectId}/worktrees` registration:

  ```go
  mux.HandleFunc("GET /api/projects/{projectId}/worktrees", wtH.ListWorktrees)
  ```

- [ ] **Step 6: Verify.**

  ```bash
  cd backend && go build ./... && go vet ./...
  go test ./... 2>&1 | tail -30
  ```

  Expected: clean. Fix any remaining test call sites (e.g. handler tests posting a worktree body without `path`, or calling `ListBranches` with an id instead of a path) as `go build`/`go test` names them.

- [ ] **Step 7: Commit.**

  ```bash
  git add backend/internal/handler/worktree.go backend/internal/handler/project.go \
    backend/internal/service/project.go backend/internal/service/worktree.go backend/cmd/server/main.go \
    backend/internal/handler/*_test.go backend/internal/service/*_test.go
  git commit -m "$(cat <<'EOF'
  feat(worktrees): path-based worktree creation and branch listing, new list-by-project endpoint

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: Hub-side federation — `GET /workspaces` fetches live worktrees from each project's machine

**Files:**
- Create: `backend/internal/machineclient/client.go`
- Modify: `backend/internal/service/workspace.go`

**Interfaces (produced):**
- `machineclient.FetchWorktrees(ctx context.Context, m domain.Machine, projectID string) ([]domain.Worktree, error)` — direct HTTP GET to the runtime, bearer-keyed, 3s timeout (mirrors the pattern already used in `handler/machine.go`'s `GetMachineHealth`).
- `WorkspaceService.List()` unchanged signature, enriched behavior: every project with a non-empty `MachineID` gets its `.Worktrees` replaced with the live result from `machineclient.FetchWorktrees` (concurrently, one goroutine per project, each independently timed out — an unreachable machine leaves that project's worktrees as an empty slice, not an error for the whole request).

- [ ] **Step 1: Create `machineclient/client.go`.**

  ```go
  // Package machineclient is the hub's server-to-server client for talking to
  // registered runtime machines directly (hub and runtimes share one
  // Tailscale tailnet — see docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md).
  // It is used to federate live, runtime-owned data (worktrees) into the
  // hub's own responses; it is not the client/proxy path browsers use.
  package machineclient

  import (
  	"context"
  	"encoding/json"
  	"fmt"
  	"net/http"
  	"strings"
  	"time"

  	"loom/backend/internal/domain"
  )

  const requestTimeout = 3 * time.Second

  // FetchWorktrees lists a project's worktrees directly from the machine that
  // owns it. Any failure (unreachable machine, non-200, bad JSON) is returned
  // as an error — callers decide how to degrade (see service/workspace.go,
  // which treats this as "worktrees unknown for now", not a fatal error).
  func FetchWorktrees(ctx context.Context, m domain.Machine, projectID string) ([]domain.Worktree, error) {
  	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
  	defer cancel()

  	url := strings.TrimRight(m.URL, "/") + "/api/projects/" + projectID + "/worktrees"
  	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
  	if err != nil {
  		return nil, err
  	}
  	req.Header.Set("Authorization", "Bearer "+m.Key)

  	resp, err := http.DefaultClient.Do(req)
  	if err != nil {
  		return nil, fmt.Errorf("machine %s unreachable: %w", m.ID, err)
  	}
  	defer resp.Body.Close()
  	if resp.StatusCode != http.StatusOK {
  		return nil, fmt.Errorf("machine %s returned status %d", m.ID, resp.StatusCode)
  	}

  	var worktrees []domain.Worktree
  	if err := json.NewDecoder(resp.Body).Decode(&worktrees); err != nil {
  		return nil, fmt.Errorf("machine %s: decode worktrees: %w", m.ID, err)
  	}
  	return worktrees, nil
  }
  ```

- [ ] **Step 2: Federate in `WorkspaceService.List()`.** Change:

  ```go
  package service

  import (
  	"loom/backend/internal/domain"
  	"loom/backend/internal/port"
  )

  // WorkspaceService wraps workspace operations with business logic.
  type WorkspaceService struct {
  	store port.Store
  }

  // NewWorkspaceService creates a workspace service.
  func NewWorkspaceService(s port.Store) *WorkspaceService {
  	return &WorkspaceService{store: s}
  }

  // List returns all workspaces with their full nested trees.
  func (svc *WorkspaceService) List() ([]domain.Workspace, error) {
  	return svc.store.Workspaces()
  }
  ```

  to:

  ```go
  package service

  import (
  	"context"
  	"log"
  	"sync"

  	"loom/backend/internal/domain"
  	"loom/backend/internal/machineclient"
  	"loom/backend/internal/port"
  )

  // WorkspaceService wraps workspace operations with business logic.
  type WorkspaceService struct {
  	store port.Store
  }

  // NewWorkspaceService creates a workspace service.
  func NewWorkspaceService(s port.Store) *WorkspaceService {
  	return &WorkspaceService{store: s}
  }

  // List returns all workspaces with their full nested trees. Worktrees are
  // runtime-owned (see docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md),
  // so for every project assigned to a machine, this replaces the store's
  // (always-empty, since the hub never holds real worktree rows) local result
  // with a live fetch from that machine, concurrently and best-effort — an
  // unreachable machine just leaves that project's worktrees empty, it does
  // not fail the whole request.
  func (svc *WorkspaceService) List() ([]domain.Workspace, error) {
  	workspaces, err := svc.store.Workspaces()
  	if err != nil {
  		return nil, err
  	}

  	var wg sync.WaitGroup
  	for wi := range workspaces {
  		for pi := range workspaces[wi].Projects {
  			proj := &workspaces[wi].Projects[pi]
  			if proj.MachineID == "" {
  				continue
  			}
  			wg.Add(1)
  			go func(proj *domain.Project) {
  				defer wg.Done()
  				machine, err := svc.store.MachineByID(proj.MachineID)
  				if err != nil {
  					log.Printf("workspaces: project %s: machine %s: %v", proj.ID, proj.MachineID, err)
  					return
  				}
  				worktrees, err := machineclient.FetchWorktrees(context.Background(), machine, proj.ID)
  				if err != nil {
  					log.Printf("workspaces: project %s: %v", proj.ID, err)
  					return
  				}
  				proj.Worktrees = worktrees
  			}(proj)
  		}
  	}
  	wg.Wait()

  	return workspaces, nil
  }

  // Create creates a workspace.
  func (svc *WorkspaceService) Create(name string) (domain.Workspace, error) {
  	if name == "" {
  		name = "New workspace"
  	}
  	return svc.store.CreateWorkspace(name)
  }

  // Update renames a workspace.
  func (svc *WorkspaceService) Update(id string, name *string) (domain.Workspace, error) {
  	return svc.store.UpdateWorkspace(id, name)
  }

  // Delete deletes a workspace and all its children.
  func (svc *WorkspaceService) Delete(id string) error {
  	return svc.store.DeleteWorkspace(id)
  }
  ```

  (Writing to `proj.Worktrees` via the `*domain.Project` pointer into the existing `workspaces[wi].Projects[pi]` slice element is safe without a mutex: each goroutine touches a distinct slice index and no goroutine appends to or reallocates the outer slice.)

- [ ] **Step 3: Verify.**

  ```bash
  cd backend && go build ./... && go vet ./...
  go test ./... 2>&1 | tail -30
  ```

  Expected: clean (no existing test should call `WorkspaceService.List()` in a way this change breaks, since the signature is unchanged — only behavior for machine-assigned projects changed, and no existing test project has a `machineId` predating this plan).

- [ ] **Step 4: Commit.**

  ```bash
  git add backend/internal/machineclient/client.go backend/internal/service/workspace.go
  git commit -m "$(cat <<'EOF'
  feat(machines): hub federates live worktree data from each project's machine

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Frontend companion — thread `path` through worktree creation and branch listing

**Files:**
- Modify: `frontend/src/lib/machineApi.ts`
- Modify: `frontend/src/features/overlays/SpawnDialog.tsx`
- Modify: `frontend/src/features/overlays/EditDrawer.tsx`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces (changed):**
- `machineApi.createWorktree(machine, projectId, body)` — `CreateWorktreeBody` gains `path: string` (required).
- `machineApi.fetchProjectBranches(machine, projectId, path)` gains a `path` parameter, sent as a query string.
- `useCreateWorktree()`'s mutation variables gain `path: string`; `useProjectBranches(machine, projectId, path)` gains the same.

- [ ] **Step 1: `machineApi.ts`.** Add `path: string` to `CreateWorktreeBody`. Change `createWorktree`:

  ```ts
  export function createWorktree(machine: Machine, projectId: string, body: CreateWorktreeBody): Promise<Worktree> {
    return machineRequest<Worktree>(machine, 'POST', `/projects/${projectId}/worktrees`, body)
  }
  ```

  (No signature change needed here — `path` rides inside `body`, which already flows through unchanged. Just confirm `CreateWorktreeBody` has the new field.)

  Change `fetchProjectBranches`:

  ```ts
  export function fetchProjectBranches(machine: Machine, projectId: string): Promise<string[]> {
    return machineRequest<string[]>(machine, 'GET', `/projects/${projectId}/branches`)
  }
  ```

  to:

  ```ts
  export function fetchProjectBranches(machine: Machine, projectId: string, path: string): Promise<string[]> {
    return machineRequest<string[]>(machine, 'GET', `/projects/${projectId}/branches?path=${encodeURIComponent(path)}`)
  }
  ```

- [ ] **Step 2: `queries.ts` — thread `path` through the hooks.** Change:

  ```ts
  export function useProjectBranches(machine: Machine | undefined, projectId: string | undefined) {
    return useQuery({
      queryKey: qk.projectBranches(machine?.id ?? '', projectId ?? ''),
      queryFn: () => fetchProjectBranches(machine!, projectId!),
      enabled: !!machine && !!projectId,
      staleTime: 30_000,
    })
  }
  ```

  to:

  ```ts
  export function useProjectBranches(machine: Machine | undefined, projectId: string | undefined, path: string | undefined) {
    return useQuery({
      queryKey: qk.projectBranches(machine?.id ?? '', projectId ?? ''),
      queryFn: () => fetchProjectBranches(machine!, projectId!, path!),
      enabled: !!machine && !!projectId && !!path,
      staleTime: 30_000,
    })
  }
  ```

  `useCreateWorktree` already passes its whole `body` through unchanged (`CreateWorktreeBody` now carries `path` — no hook-level change needed there beyond the type already picking up the new field).

- [ ] **Step 3: `SpawnDialog.tsx`.** It already resolves `project` (has `project.path`). Update its `useProjectBranches(machine, project?.id)` call to `useProjectBranches(machine, project?.id, project?.path)`. Update wherever it builds the `useCreateWorktree().mutate({ machine, projectId, body })` call to include `path: project.path` in `body`.

- [ ] **Step 4: `EditDrawer.tsx`.** It resolves `editProject`/`editMachine` (from Task 4 of the frontend plan). Update `useProjectBranches(editMachine, editProject?.id)` to `useProjectBranches(editMachine, editProject?.id, editProject?.path)`.

- [ ] **Step 5: Verify.**

  ```bash
  cd frontend && npm run typecheck && npm run build
  ```

  Expected: clean.

- [ ] **Step 6: Commit.**

  ```bash
  git add frontend/src/lib/machineApi.ts frontend/src/features/overlays/SpawnDialog.tsx \
    frontend/src/features/overlays/EditDrawer.tsx frontend/src/features/data/queries.ts
  git commit -m "$(cat <<'EOF'
  feat(machines): pass project path through worktree creation and branch listing

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: End-to-end re-verification

**Files:** none (verification only) — this repeats the exact walkthrough that failed in sub-project #2's Task 6, now expected to fully succeed.

- [ ] **Step 1: Full build check.**

  ```bash
  cd backend && go vet ./... && go test ./... && go build ./cmd/server
  cd ../frontend && npm run typecheck && npm run build
  ```

- [ ] **Step 2: Two-node walkthrough (real browser).** Build the binary, start `--role runtime --key rtk` and `--role hub --key hubk --2fa=false` on the test ports, start the frontend dev server pointed at the hub. Register the runtime as a machine, create a project on it via real folder browsing (a real local git repo with at least two branches), then:
  - Spawn a worktree: confirm the branch dropdown is populated (this was the original 404 point) and creation succeeds (no "not found" toast).
  - Reload the workspace / revisit the project page: confirm the newly created worktree **appears** in the UI (this is the federation fix — it must show up via the hub's own `GET /workspaces`, not require any direct-to-runtime call from the browser to be visible).
  - Open the worktree: terminal connects, Git panel shows real status, file explorer lists real files, file editor loads a file and (for a `.go`/`.ts` file) shows LSP diagnostics.
  - Kill the runtime process: confirm the Machines page flips offline; confirm `GET /workspaces` still returns successfully (project just shows stale/last-known or empty worktrees for that project, not a 500 for the whole tree). Restart the runtime, confirm recovery.

- [ ] **Step 3: Report.** No commit for this task unless the walkthrough finds a bug — if it does, fix it as a new commit before considering this done.

---

## Notes for execution

- Continue on branch `feat/frontend-multi-machine` (already has the frontend files this plan's Task 5 touches).
- Tasks 1→2→3 are strictly ordered (schema → service → handlers). Task 4 depends on Task 3's new list endpoint existing. Task 5 depends on Task 3's route/body changes. Task 6 depends on everything.
- Once Task 6 passes clean, merge `feat/frontend-multi-machine` into `multi-runtime-master` (squash or as-is, operator's call) — this closes out sub-projects #2 and #1.5 together, since #1.5 only exists because #2's own verification caught it.
