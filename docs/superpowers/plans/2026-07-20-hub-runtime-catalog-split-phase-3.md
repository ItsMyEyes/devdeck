# Hub/Runtime Catalog Split — Phase 3 (Offline Project Create + Replay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create a project on a runtime while the hub is unreachable, and have it replay to the hub — insert-only, ID preserved — the next time the sync loop succeeds.

**Architecture:** A project created on a runtime is marked `origin='local'`. The runtime's existing 30s sync loop (`service.RunSyncLoop`, built in Phase 2) gains a push step that runs *before* its pull: POST each `origin='local'` project to a new hub endpoint, which forces the calling machine's ID from its authenticated key (never from the request body) and upserts by the runtime-minted ID. On success the runtime flips the row to `origin='hub'`; on a 409 (the project's workspace no longer exists on the hub) it records why and keeps retrying — the project and its local workspace row stay fully usable either way, since nothing here ever touches worktrees or deletes a workspace still referenced by a local project (both already guaranteed by Phase 2).

**Tech Stack:** Go 1.22+ (`net/http` enhanced ServeMux, `database/sql` + SQLite), React 19 + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md` (decision 3; "Catalog sync protocol" → "The `origin` column"; "Two failure cases with explicit policy"; "Route split" → the `DELETE`-when-local corollary).

**Builds on:** `docs/superpowers/plans/2026-07-19-hub-runtime-catalog-split-phase-1-2.md` (already implemented — `RequireMachineKey`, `MachineFromContext`, `CatalogHandler`, `ApplyCatalogSnapshot`, `RunSyncLoop`, `NewWorkspaceServiceForRuntime` all exist in the repo today).

## Global Constraints

- Module path is `devdeck/backend`; internal packages under `devdeck/backend/internal/`.
- All API errors use the `{"error":"message"}` envelope. Never change this shape.
- Store errors map to HTTP via `handleStoreErr(w, err)`. Never leak raw SQL errors.
- All persistence goes through the `port.Store` interface (`backend/internal/port/store.go`).
- Domain types in `backend/internal/domain/models.go` and `frontend/src/store/types.ts` must stay in sync.
- SQLite only; `?` placeholders, never `$1`.
- IDs are type-prefixed hex via `idGen("p-")` (`crypto/rand`) — never reissue an ID a caller already minted.
- Frontend imports use the `@/*` alias — never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Run `go vet ./...` and `npm run typecheck` before every commit.
- **Do not modify `frontend/src/lib/machineClient.ts`.**
- These tasks touch convergence files (`main.go`, `port/store.go`, `domain/models.go`, `types.ts`) repeatedly — per `CLAUDE.md` they must be edited serially, one task at a time, never by parallel agents.

## Why the push must flip `origin` before the pull, in the same cycle

This is the single easiest bug to reintroduce, so read it before touching `service/sync.go`.

`RunSyncLoop`'s existing order is push, then pull, in the same tick (Phase 2's design). Today's `ApplyCatalogSnapshot` (`backend/internal/store/catalog.go`) does a **plain, non-upsert** `INSERT INTO projects (...)` for each row in the pulled snapshot. If a project was just replayed successfully and is *still* marked `origin='local'` when the pull runs moments later, the pull's snapshot will include that same project (the hub now has it), the apply's `DELETE FROM projects WHERE origin = 'hub'` step won't touch the still-`'local'`-flagged row, and the subsequent `INSERT` for that same ID hits the `PRIMARY KEY` constraint — **the whole snapshot transaction rolls back**, silently breaking sync for every project on that runtime, not just the replayed one.

Task 6 makes `ApplyCatalogSnapshot`'s insert idempotent (defense in depth), but Task 7 must still flip a successfully replayed project to `origin='hub'` immediately, before the pull step runs — don't rely on the hardening alone to paper over getting the ordering wrong.

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/store/db.go` (modify) | `sync_error` column + migration |
| `backend/internal/domain/models.go` (modify) | `Project.Origin`, `Project.SyncError` |
| `backend/internal/store/project.go` (modify) | `projectsOf`/`ProjectByID` read `origin`, `sync_error` |
| `frontend/src/store/types.ts` (modify) | `Project.origin`, `Project.syncError` |
| `backend/internal/store/projectsync.go` (create) | `MarkProjectSynced`, `SetProjectSyncError`, `LocalProjects` |
| `backend/internal/service/workspace.go`-sibling: `backend/internal/service/project.go` (modify) | runtime-mode `ProjectService`, origin marking, delete gating |
| `backend/internal/service/errors.go` (modify) | new `ErrForbidden` sentinel (403) |
| `backend/internal/handler/middleware.go` (modify) | `handleStoreErr` maps `ErrForbidden` → 403 |
| `backend/internal/store/catalog.go` (modify) | `ReplayLocalProject`; idempotent project upsert in `ApplyCatalogSnapshot` |
| `backend/internal/service/catalog.go` (create) | `CatalogService.ReplayProject` — translates "workspace missing" into `service.ErrConflict` |
| `backend/internal/handler/catalog.go` (modify) | `PostProject` handler for `POST /api/runtime/projects` |
| `backend/internal/machineclient/catalog.go` (modify) | `ReplayProject` client call |
| `backend/internal/service/sync.go` (modify) | push loop before pull |
| `backend/cmd/server/main.go` (modify) | wire runtime-mode `ProjectService`; mount the new hub route |
| `frontend/src/features/sidebar/ProjectSyncBadge.tsx` (create) | "not yet synced" / "won't sync: …" indicator |
| `frontend/src/features/sidebar/ProjectTree.tsx` (modify) | render the badge per project row |

---

### Task 1: Expose `origin` and `sync_error` on reads

**Files:**
- Modify: `backend/internal/store/db.go` (schema block at `projects` table, ~line 18-28; migration section near `migrateProjectOrigin`, ~line 432)
- Modify: `backend/internal/domain/models.go:33-49` (`Project` struct)
- Modify: `backend/internal/store/project.go` (`projectsOf`, `ProjectByID`)
- Modify: `frontend/src/store/types.ts` (`Project` interface)
- Test: `backend/internal/store/project_test.go` (create)

**Interfaces:**
- Produces: `domain.Project.Origin string` (`"hub"` or `"local"`), `domain.Project.SyncError *string` — read by every later task in this plan and by the frontend.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/store/project_test.go`:

```go
package store

import "testing"

func TestProjectByIDReadsOriginAndSyncError(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, err := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "hub" {
		t.Errorf("Origin on a freshly created project = %q, want hub (the schema default)", p.Origin)
	}
	if p.SyncError != nil {
		t.Errorf("SyncError on a freshly created project = %v, want nil", p.SyncError)
	}

	// Set sync_error directly via SQL — the write helper for this doesn't
	// exist until Task 2. This test is only proving the READ path here.
	if _, err := s.db.Exec(`UPDATE projects SET origin = 'local', sync_error = ? WHERE id = ?`, "workspace was deleted", p.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "local" {
		t.Errorf("Origin after direct update = %q, want local", got.Origin)
	}
	if got.SyncError == nil || *got.SyncError != "workspace was deleted" {
		t.Errorf("SyncError after direct update = %v, want \"workspace was deleted\"", got.SyncError)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./internal/store/ -run TestProjectByIDReadsOriginAndSyncError -v
```

Expected: FAIL — `p.Origin undefined (type domain.Project has no field or method Origin)`.

- [ ] **Step 3: Add the schema column and migration**

In `backend/internal/store/db.go`, the `projects` table already has an `origin` column from Phase 2 (look for the comment starting "origin distinguishes a runtime-replica row..."). Add `sync_error` right after it:

```sql
  -- sync_error is set when this runtime's most recent replay attempt for a
  -- local project failed permanently (its workspace no longer exists on the
  -- hub) — as opposed to merely not-yet-attempted or a transient network
  -- failure, neither of which touch this column. Cleared on a successful
  -- replay. Only meaningful alongside origin='local'.
  sync_error   TEXT,
```

Add a migration function near `migrateProjectOrigin` (`backend/internal/store/db.go`, ~line 432):

```go
// migrateProjectSyncError adds the sync_error column to pre-existing
// databases. Errors from a column that's already present are expected and
// ignored.
func migrateProjectSyncError(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN sync_error TEXT"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}
```

Call it right after `migrateProjectOrigin(db)` in `Open`. The exact existing call site (`backend/internal/store/db.go`, immediately before `return db, nil`) is:

```go
	if err := migrateProjectOrigin(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
```

Insert the new call between those two, matching its exact shape (close the db, return the raw error — no `fmt.Errorf` wrapping is used at this call site, don't add one):

```go
	if err := migrateProjectOrigin(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateProjectSyncError(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
```

- [ ] **Step 4: Add the domain fields**

In `backend/internal/domain/models.go`, extend `Project` (the struct currently ending `Issues []Issue`):

```go
	// Origin distinguishes a runtime-replica row synced from the hub ("hub")
	// from one created locally while the hub was unreachable ("local").
	// Only meaningful on a runtime; the hub's own projects are always "hub"
	// and never read this field.
	Origin string `json:"origin"`
	// SyncError is set when this runtime's most recent replay attempt for a
	// origin="local" project failed permanently (its workspace no longer
	// exists on the hub). Nil means either already synced, or not yet
	// attempted, or the last attempt failed only transiently.
	SyncError *string `json:"syncError,omitempty"`
```

- [ ] **Step 5: Update the store reads**

In `backend/internal/store/project.go`, `projectsOf` currently selects `id, name, repo, path, expanded, machine_id`. Change its query and scan:

```go
func (s *Store) projectsOf(wsID string) ([]domain.Project, error) {
	rows, err := s.db.Query(`SELECT id, name, repo, path, expanded, machine_id, origin, sync_error FROM projects WHERE workspace_id = ? ORDER BY rowid ASC`, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var syncError sql.NullString
		if err := rows.Scan(&p.ID, &p.Name, &p.Repo, &p.Path, &p.Expanded, &p.MachineID, &p.Origin, &syncError); err != nil {
			return nil, err
		}
		if syncError.Valid {
			v := syncError.String
			p.SyncError = &v
		}
		out = append(out, p)
	}
	...
```

(Keep the rest of the function — the `rows.Err()` check and the per-project worktrees/issues loop — unchanged.) Add `"database/sql"` to the file's imports if not already present (check first — `sql.NullString` requires it).

Do the same for `ProjectByID`:

```go
func (s *Store) ProjectByID(id string) (domain.Project, error) {
	var p domain.Project
	var syncError sql.NullString
	err := s.db.QueryRow(`SELECT id, name, repo, path, expanded, machine_id, origin, sync_error FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Repo, &p.Path, &p.Expanded, &p.MachineID, &p.Origin, &syncError)
	if err != nil {
		return domain.Project{}, mapNotFound(err)
	}
	if syncError.Valid {
		v := syncError.String
		p.SyncError = &v
	}
	if p.Worktrees, err = s.worktreesOf(id); err != nil {
		return p, err
	}
	if p.Issues, err = s.issuesOf(id); err != nil {
		return p, err
	}
	return p, nil
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd backend && go test ./internal/store/ -run TestProjectByIDReadsOriginAndSyncError -v && go test ./internal/... && go vet ./...
```

Expected: new test PASSES; full suite still green (a fresh test DB always gets the `CREATE TABLE IF NOT EXISTS` shape with `sync_error` already in it, so the migration path only matters for pre-existing on-disk databases).

- [ ] **Step 7: Add the frontend field**

In `frontend/src/store/types.ts`, find the `Project` interface (it currently has `id`, `name`, `repo`, `path`, `expanded`, `machineId`, `workspaceId`, `worktrees`, `issues`) and add:

```ts
  /** "hub" (synced) or "local" (created on this runtime, not yet replayed). Only meaningful on a runtime. */
  origin: string
  /** Set when this runtime's last replay attempt failed permanently (e.g. its workspace no longer exists on the hub). */
  syncError?: string
```

- [ ] **Step 8: Typecheck and commit**

```bash
cd frontend && npm run typecheck
```

```bash
git add backend/internal/store/db.go backend/internal/domain/models.go \
        backend/internal/store/project.go backend/internal/store/project_test.go \
        frontend/src/store/types.ts
git commit -m "feat(store): expose project origin and sync_error on reads"
```

---

### Task 2: Write helpers — `MarkProjectSynced`, `SetProjectSyncError`, `LocalProjects`

**Files:**
- Create: `backend/internal/store/projectsync.go`
- Modify: `backend/internal/port/store.go`
- Test: `backend/internal/store/projectsync_test.go`

**Interfaces:**
- Consumes: `domain.Project.Origin`/`SyncError` (Task 1).
- Produces: `MarkProjectSynced(id string) error`, `SetProjectSyncError(id, msg string) error`, `LocalProjects() ([]domain.Project, error)` — used by Task 5 (replay) and Task 7 (push loop).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/store/projectsync_test.go`:

```go
package store

import "testing"

func TestMarkProjectSyncedClearsLocalOriginAndSyncError(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, _ := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := s.MarkProjectLocal(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProjectSyncError(p.ID, "workspace was deleted"); err != nil {
		t.Fatal(err)
	}

	if err := s.MarkProjectSynced(p.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin after MarkProjectSynced = %q, want hub", got.Origin)
	}
	if got.SyncError != nil {
		t.Errorf("SyncError after MarkProjectSynced = %v, want nil (cleared)", got.SyncError)
	}
}

func TestSetProjectSyncErrorLeavesOriginLocal(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, _ := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := s.MarkProjectLocal(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProjectSyncError(p.ID, "workspace was deleted"); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "local" {
		t.Errorf("Origin after SetProjectSyncError = %q, want local (still unsynced)", got.Origin)
	}
	if got.SyncError == nil || *got.SyncError != "workspace was deleted" {
		t.Errorf("SyncError = %v, want \"workspace was deleted\"", got.SyncError)
	}
}

func TestLocalProjectsReturnsOnlyLocalOrigin(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	synced, _ := s.CreateProject(ws.ID, "synced", "/srv/synced", "", "")
	local, _ := s.CreateProject(ws.ID, "local", "/srv/local", "", "")
	if err := s.MarkProjectLocal(local.ID); err != nil {
		t.Fatal(err)
	}

	got, err := s.LocalProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != local.ID {
		t.Fatalf("LocalProjects() = %+v, want only %s (not %s)", got, local.ID, synced.ID)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/store/ -run "TestMarkProjectSynced|TestSetProjectSyncError|TestLocalProjects"
```

Expected: FAIL — `s.MarkProjectSynced undefined`, `s.SetProjectSyncError undefined`, `s.LocalProjects undefined`.

- [ ] **Step 3: Implement**

Create `backend/internal/store/projectsync.go`:

```go
package store

import "devdeck/backend/internal/domain"

// MarkProjectSynced flips a project from origin='local' back to 'hub' and
// clears any sync_error, after the hub has accepted a replay of it. This
// must happen before the sync loop's next pull applies a fresh snapshot in
// the same cycle: ApplyCatalogSnapshot only deletes origin='hub' rows before
// reinserting, so a project still marked 'local' at that point would collide
// on its own primary key with the snapshot's copy of the same row.
func (s *Store) MarkProjectSynced(id string) error {
	_, err := s.db.Exec(`UPDATE projects SET origin = 'hub', sync_error = NULL WHERE id = ?`, id)
	return err
}

// SetProjectSyncError records why a local project's replay failed
// permanently (its workspace no longer exists on the hub), without changing
// origin — the row stays local and fully usable, just flagged so the
// operator knows it will never sync as-is.
func (s *Store) SetProjectSyncError(id, msg string) error {
	_, err := s.db.Exec(`UPDATE projects SET sync_error = ? WHERE id = ?`, msg, id)
	return err
}

// LocalProjects returns every project this runtime created while the hub was
// unreachable and has not yet successfully replayed.
func (s *Store) LocalProjects() ([]domain.Project, error) {
	rows, err := s.db.Query(`SELECT id, workspace_id, name, repo, path, expanded, machine_id, origin, sync_error FROM projects WHERE origin = 'local' ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var syncError sql.NullString
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.Repo, &p.Path, &p.Expanded, &p.MachineID, &p.Origin, &syncError); err != nil {
			return nil, err
		}
		if syncError.Valid {
			v := syncError.String
			p.SyncError = &v
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
```

Add `"database/sql"` to the imports (needed for `sql.NullString`).

Add to `port.Store` in `backend/internal/port/store.go`, alongside the other Phase 2 catalog methods (`MarkProjectLocal`, `ApplyCatalogSnapshot`, `LastSyncedAt`):

```go
	MarkProjectSynced(id string) error
	SetProjectSyncError(id, msg string) error
	LocalProjects() ([]domain.Project, error)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/store/ -run "TestMarkProjectSynced|TestSetProjectSyncError|TestLocalProjects" -v && go test ./internal/... && go vet ./...
```

Expected: all three PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/store/projectsync.go backend/internal/store/projectsync_test.go backend/internal/port/store.go
git commit -m "feat(store): add MarkProjectSynced, SetProjectSyncError, LocalProjects"
```

---

### Task 3: Runtime-mode `ProjectService` marks new projects `origin='local'`

**Files:**
- Modify: `backend/internal/service/project.go`
- Modify: `backend/cmd/server/main.go` (project service construction, ~line 221)
- Test: `backend/internal/service/project_test.go` (create)

**Interfaces:**
- Consumes: `MarkProjectLocal` (exists since Phase 2).
- Produces: `NewProjectServiceForRuntime(s port.Store) *ProjectService` — used by Task 4 and by `main.go`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/project_test.go`:

```go
package service

import (
	"testing"

	"devdeck/backend/internal/store"
)

func TestRuntimeProjectServiceMarksCreatedProjectsLocal(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")

	svc := NewProjectServiceForRuntime(st)
	p, err := svc.Create(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "local" {
		t.Errorf("Origin after runtime-mode Create = %q, want local", p.Origin)
	}
}

func TestHubProjectServiceLeavesCreatedProjectsAsHub(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")

	svc := NewProjectService(st)
	p, err := svc.Create(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "hub" {
		t.Errorf("Origin after hub-mode Create = %q, want hub (unchanged control)", p.Origin)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/service/ -run "TestRuntimeProjectServiceMarksCreatedProjectsLocal|TestHubProjectServiceLeavesCreatedProjectsAsHub"
```

Expected: FAIL — `undefined: NewProjectServiceForRuntime` (the second test should already pass once compilation succeeds — it's the control, asserting today's behavior is unchanged).

- [ ] **Step 3: Implement**

In `backend/internal/service/project.go`, change the struct and add the constructor (mirroring `WorkspaceService`'s exact pattern from Phase 2):

```go
// ProjectService wraps project operations with business logic.
type ProjectService struct {
	store   port.Store
	runtime bool
}

// NewProjectService creates a project service for the hub role.
func NewProjectService(s port.Store) *ProjectService {
	return &ProjectService{store: s}
}

// NewProjectServiceForRuntime creates a project service for the runtime
// role. Projects it creates are marked origin="local" until the sync loop
// replays them to the hub (see service.RunSyncLoop) — this is the only
// difference from the hub role's behavior.
func NewProjectServiceForRuntime(s port.Store) *ProjectService {
	return &ProjectService{store: s, runtime: true}
}
```

Update `Create` to mark the row local when running on a runtime:

```go
// Create creates a project under a workspace.
func (svc *ProjectService) Create(wsID, name, path, repo, machineID string) (domain.Project, error) {
	name = strings.TrimSpace(name)
	path = strings.TrimSpace(path)
	if name == "" {
		name = lastSegment(path)
	}
	if name == "" {
		name = "new-project"
	}
	if path == "" {
		path = "~/dev/" + name
	}
	p, err := svc.store.CreateProject(wsID, name, path, repo, machineID)
	if err != nil {
		return domain.Project{}, err
	}
	if svc.runtime {
		if err := svc.store.MarkProjectLocal(p.ID); err != nil {
			return domain.Project{}, err
		}
		p.Origin = "local"
	}
	return p, nil
}
```

Do the same at the two success-returning points in `Clone` (the machine-dispatch branch and the local-clone branch), each of which currently ends with a bare `return svc.store.CreateProject(...)` or `return project, nil`. Replace the machine-dispatch branch's return:

```go
		p, err := svc.store.CreateProject(wsID, name, path, repo, machineID)
		if err != nil {
			return domain.Project{}, err
		}
		if svc.runtime {
			if err := svc.store.MarkProjectLocal(p.ID); err != nil {
				return domain.Project{}, err
			}
			p.Origin = "local"
		}
		return p, nil
```

And the local-clone branch's tail (currently `project, err := svc.store.CreateProject(wsID, name, path, repo, ""); if err != nil {...}; return project, nil`):

```go
	project, err := svc.store.CreateProject(wsID, name, path, repo, "")
	if err != nil {
		_ = os.RemoveAll(resolved)
		return domain.Project{}, err
	}
	if svc.runtime {
		if err := svc.store.MarkProjectLocal(project.ID); err != nil {
			return domain.Project{}, err
		}
		project.Origin = "local"
	}
	return project, nil
```

(Setting `p.Origin`/`project.Origin` directly avoids a second round-trip through `ProjectByID` just to re-read what we already know we just wrote.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/service/ -run "TestRuntimeProjectServiceMarksCreatedProjectsLocal|TestHubProjectServiceLeavesCreatedProjectsAsHub" -v && go test ./internal/... && go vet ./...
```

Expected: both PASS, full suite green.

- [ ] **Step 5: Wire it into main.go**

In `backend/cmd/server/main.go`, replace the single-line construction near line 221 (`pSvc := service.NewProjectService(st)`) with role-aware construction, matching the existing `wsSvc` pattern from Phase 2:

```go
	var pSvc *service.ProjectService
	if isRuntime {
		pSvc = service.NewProjectServiceForRuntime(st)
	} else {
		pSvc = service.NewProjectService(st)
	}
```

- [ ] **Step 6: Verify and commit**

```bash
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

```bash
git add backend/internal/service/project.go backend/internal/service/project_test.go backend/cmd/server/main.go
git commit -m "feat(runtime): mark projects created on a runtime as origin=local"
```

---

### Task 4: Gate `DELETE /api/projects/{id}` to `origin='local'` on a runtime

**Files:**
- Modify: `backend/internal/service/errors.go` (new `ErrForbidden`)
- Modify: `backend/internal/handler/middleware.go` (`handleStoreErr` mapping)
- Modify: `backend/internal/service/project.go` (`Delete`)
- Test: `backend/internal/handler/middleware_test.go`, `backend/internal/service/project_test.go`

**Interfaces:**
- Produces: `service.ErrForbidden` (maps to HTTP 403 via `handleStoreErr`) — reusable by any later feature needing the same "valid request, wrong role/state" shape.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/handler/middleware_test.go`:

```go
func TestHandleStoreErrMapsErrForbiddenTo403(t *testing.T) {
	rec := httptest.NewRecorder()
	if !handleStoreErr(rec, fmt.Errorf("cannot delete a hub-synced project from a runtime: %w", service.ErrForbidden)) {
		t.Fatal("handleStoreErr returned false for a non-nil error")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}
```

Check the file's existing imports first — it should already import `net/http/httptest`, `net/http`, and `devdeck/backend/internal/service`; add `"fmt"` if absent.

Append to `backend/internal/service/project_test.go`:

```go
func TestRuntimeProjectServiceRefusesToDeleteASyncedProject(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	synced, _ := st.CreateProject(ws.ID, "synced", "/srv/synced", "", "") // origin defaults to "hub"

	svc := NewProjectServiceForRuntime(st)
	err := svc.Delete(synced.ID)
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("Delete(synced project) error = %v, want ErrForbidden", err)
	}
	if _, err := st.ProjectByID(synced.ID); err != nil {
		t.Errorf("synced project was deleted despite the rejection: %v", err)
	}
}

func TestRuntimeProjectServiceDeletesALocalProject(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	local, _ := st.CreateProject(ws.ID, "local", "/srv/local", "", "")
	if err := st.MarkProjectLocal(local.ID); err != nil {
		t.Fatal(err)
	}

	svc := NewProjectServiceForRuntime(st)
	if err := svc.Delete(local.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ProjectByID(local.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("local project still exists after Delete: err=%v", err)
	}
}

func TestHubProjectServiceDeletesAnyProject(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	p, _ := st.CreateProject(ws.ID, "api", "/srv/api", "", "")

	svc := NewProjectService(st)
	if err := svc.Delete(p.ID); err != nil {
		t.Fatalf("hub-mode Delete of a hub-origin project failed: %v (control — must be unchanged)", err)
	}
}
```

Add `"errors"` and `"devdeck/backend/internal/store"` to the file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/handler/ -run TestHandleStoreErrMapsErrForbiddenTo403
cd backend && go test ./internal/service/ -run "TestRuntimeProjectServiceRefusesToDeleteASyncedProject|TestRuntimeProjectServiceDeletesALocalProject|TestHubProjectServiceDeletesAnyProject"
```

Expected: FAIL — `undefined: service.ErrForbidden` in the handler test; `undefined: ErrForbidden` in the service tests.

- [ ] **Step 3: Add the sentinel error**

In `backend/internal/service/errors.go`, append:

```go
// ErrForbidden indicates the request is well-formed and the credential is
// valid, but this specific action isn't allowed given the resource's current
// state (e.g. deleting a hub-synced project from a runtime). Wrap it with
// fmt.Errorf("...: %w", ErrForbidden) — handleStoreErr maps it to HTTP 403.
var ErrForbidden = errors.New("forbidden")
```

In `backend/internal/handler/middleware.go`, add a branch to `handleStoreErr` right after the existing `service.ErrLocked` check:

```go
	if errors.Is(err, service.ErrLocked) {
		writeErr(w, http.StatusLocked, err.Error())
		return true
	}
	if errors.Is(err, service.ErrForbidden) {
		writeErr(w, http.StatusForbidden, err.Error())
		return true
	}
```

- [ ] **Step 4: Gate `Delete`**

In `backend/internal/service/project.go`, replace `Delete`:

```go
// Delete deletes a project and its worktrees. On a runtime, only a project
// that has never reached the hub (origin="local") may be deleted this way —
// removing something that never synced is purely local; once origin="hub",
// deletion must go through the hub instead.
func (svc *ProjectService) Delete(id string) error {
	if svc.runtime {
		p, err := svc.store.ProjectByID(id)
		if err != nil {
			return err
		}
		if p.Origin != "local" {
			return fmt.Errorf("cannot delete a hub-synced project from a runtime: %w", ErrForbidden)
		}
	}
	return svc.store.DeleteProject(id)
}
```

Add `"devdeck/backend/internal/domain"` if not already imported (it likely already is, for `domain.Project` return types elsewhere in the file) — confirm with a quick check, and add `"fmt"` if absent (the file already imports it for `Clone`'s error wrapping).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/handler/ -run TestHandleStoreErrMapsErrForbiddenTo403 -v
cd backend && go test ./internal/service/ -run "TestRuntimeProjectServiceRefusesToDeleteASyncedProject|TestRuntimeProjectServiceDeletesALocalProject|TestHubProjectServiceDeletesAnyProject" -v
cd backend && go test ./internal/... && go vet ./...
```

Expected: all four PASS, full suite green.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/errors.go backend/internal/handler/middleware.go \
        backend/internal/handler/middleware_test.go backend/internal/service/project.go \
        backend/internal/service/project_test.go
git commit -m "feat(runtime): only allow deleting origin=local projects on a runtime"
```

---

### Task 5: Hub-side replay endpoint — `POST /api/runtime/projects`

**Files:**
- Modify: `backend/internal/store/catalog.go` (`ReplayLocalProject`)
- Create: `backend/internal/service/catalog.go`
- Modify: `backend/internal/handler/catalog.go` (`PostProject`)
- Modify: `backend/internal/port/store.go`
- Modify: `backend/cmd/server/main.go` (mount the route)
- Test: `backend/internal/store/catalog_test.go`, `backend/internal/handler/catalog_test.go`

**Interfaces:**
- Consumes: `RequireMachineKey`, `MachineFromContext` (exist since Phase 2).
- Produces: `store.ReplayLocalProject(id, wsID, name, path, repo, machineID string) (domain.Project, error)`; `service.CatalogService.ReplayProject(machineID string, req ReplayProjectRequest) (domain.Project, error)`; `POST /api/runtime/projects` on the hub.

- [ ] **Step 1: Write the failing store test**

Append to `backend/internal/store/catalog_test.go`:

```go
func TestReplayLocalProjectPreservesIDAndForcesMachineID(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")

	p, err := s.ReplayLocalProject("p-fixed-id-123", ws.ID, "api", "/srv/api", "", "m-a")
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "p-fixed-id-123" {
		t.Errorf("ID = %q, want the exact ID the caller supplied (worktrees on the runtime already point at it)", p.ID)
	}
	if p.MachineID != "m-a" {
		t.Errorf("MachineID = %q, want m-a", p.MachineID)
	}
	if p.Origin != "hub" {
		t.Errorf("Origin = %q, want hub — a replayed project is now the hub's canonical row", p.Origin)
	}
}

func TestReplayLocalProjectIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")

	if _, err := s.ReplayLocalProject("p-retry-1", ws.ID, "api", "/srv/api", "", "m-a"); err != nil {
		t.Fatal(err)
	}
	// Simulate a retried push after the first response was lost in transit.
	p, err := s.ReplayLocalProject("p-retry-1", ws.ID, "api", "/srv/api", "", "m-a")
	if err != nil {
		t.Fatalf("retrying the same replay failed: %v, want a clean idempotent no-op", err)
	}
	if p.ID != "p-retry-1" {
		t.Errorf("ID after retry = %q, want p-retry-1", p.ID)
	}

	all, err := s.ProjectsByMachine("m-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("ProjectsByMachine(m-a) = %+v, want exactly one row (retry must not duplicate)", all)
	}
}

func TestReplayLocalProjectRejectsAMissingWorkspace(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.ReplayLocalProject("p-orphan", "ws-does-not-exist", "api", "/srv/api", "", "m-a"); !errors.Is(err, ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound (the service layer translates this into a 409)", err)
	}
}
```

Add `"errors"` to the file's imports if not already present.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./internal/store/ -run "TestReplayLocalProject"
```

Expected: FAIL — `s.ReplayLocalProject undefined`.

- [ ] **Step 3: Implement the store method**

Append to `backend/internal/store/catalog.go`:

```go
// ReplayLocalProject inserts a project a runtime created while the hub was
// unreachable. Two things are non-negotiable:
//
//   - The ID is preserved exactly as the caller supplied it, never reissued:
//     the runtime's own worktrees already point at it.
//   - machineID always comes from the authenticated caller (RequireMachineKey
//     in the handler layer), never from request content — mirrors
//     CatalogForMachine's "structurally cannot express another machine"
//     guarantee from Phase 2.
//
// Retrying the same id is a safe no-op, not a duplicate-row error: a runtime
// whose first response was lost in transit will retry on the next sync tick,
// and the hub may already have accepted it.
func (s *Store) ReplayLocalProject(id, wsID, name, path, repo, machineID string) (domain.Project, error) {
	ok, err := s.workspaceExists(wsID)
	if err != nil {
		return domain.Project{}, err
	}
	if !ok {
		return domain.Project{}, ErrNotFound
	}
	_, err = s.db.Exec(`
		INSERT INTO projects (id, workspace_id, name, repo, path, expanded, machine_id, origin)
		VALUES (?, ?, ?, ?, ?, 1, ?, 'hub')
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name, path = excluded.path, repo = excluded.repo
		WHERE machine_id = excluded.machine_id
	`, id, wsID, name, repo, path, machineID)
	if err != nil {
		return domain.Project{}, err
	}
	return s.ProjectByID(id)
}
```

Add to `port.Store` in `backend/internal/port/store.go`:

```go
	ReplayLocalProject(id, wsID, name, path, repo, machineID string) (domain.Project, error)
```

- [ ] **Step 4: Run the store tests to verify they pass**

```bash
cd backend && go test ./internal/store/ -run "TestReplayLocalProject" -v
```

Expected: all three PASS.

- [ ] **Step 5: Write the failing handler test**

Append to `backend/internal/handler/catalog_test.go`:

```go
func TestPostProjectReplayScopesToPresentedMachineAndTranslates409(t *testing.T) {
	st := newCatalogTestStore(t)
	ws, _ := st.CreateWorkspace("orphanable")

	catalogSvc := service.NewCatalogService(st)
	h := NewCatalogHandler(st, catalogSvc)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/runtime/projects", h.PostProject)
	router := RequireMachineKey(st)(mux)

	body := `{"id":"p-offline-1","workspaceId":"` + ws.ID + `","name":"api","path":"/srv/api"}`
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/projects", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer key-a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	var got domain.Project
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ID != "p-offline-1" {
		t.Errorf("ID = %q, want p-offline-1 (preserved)", got.ID)
	}
	if got.MachineID != "m-a" {
		t.Errorf("MachineID = %q, want m-a (forced from the presented key, not from the body)", got.MachineID)
	}

	// Replaying against a workspace that doesn't exist must come back 409,
	// not the store's raw 404 — the spec calls this out explicitly so a
	// runtime can tell "retry later" apart from "gone forever".
	badBody := `{"id":"p-orphan","workspaceId":"ws-does-not-exist","name":"x","path":"/srv/x"}`
	req2 := httptest.NewRequest(http.MethodPost, "/api/runtime/projects", strings.NewReader(badBody))
	req2.Header.Set("Authorization", "Bearer key-a")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec2.Code)
	}
}
```

Check the file's existing imports and add `"devdeck/backend/internal/service"`, `"encoding/json"`, `"strings"` if not already present.

- [ ] **Step 6: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestPostProjectReplayScopesToPresentedMachineAndTranslates409
```

Expected: FAIL — `undefined: service.NewCatalogService`, `not enough arguments in call to NewCatalogHandler`.

- [ ] **Step 7: Implement the service layer**

Create `backend/internal/service/catalog.go`:

```go
package service

import (
	"errors"
	"fmt"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// CatalogService handles hub-side operations on data pushed up from runtimes.
type CatalogService struct {
	store port.Store
}

// NewCatalogService creates a catalog service.
func NewCatalogService(s port.Store) *CatalogService {
	return &CatalogService{store: s}
}

// ReplayProjectRequest is one project a runtime created while the hub was
// unreachable, being pushed up for the hub to accept. MachineID is
// deliberately absent: the caller is always the authenticated machine
// itself (see handler.RequireMachineKey), never a value the request
// controls.
type ReplayProjectRequest struct {
	ID          string
	WorkspaceID string
	Name        string
	Path        string
	Repo        string
}

// ReplayProject accepts one replayed project for machineID (resolved from
// the caller's own key, never from the request). Translates the store's
// generic "workspace not found" into ErrConflict (409): the spec requires a
// runtime be able to distinguish "the hub hasn't seen this yet, retry" from
// "this project's workspace is gone for good".
func (svc *CatalogService) ReplayProject(machineID string, req ReplayProjectRequest) (domain.Project, error) {
	p, err := svc.store.ReplayLocalProject(req.ID, req.WorkspaceID, req.Name, req.Path, req.Repo, machineID)
	if errors.Is(err, store.ErrNotFound) {
		return domain.Project{}, fmt.Errorf("workspace %s does not exist: %w", req.WorkspaceID, ErrConflict)
	}
	return p, err
}
```

- [ ] **Step 8: Implement the handler**

In `backend/internal/handler/catalog.go`, add the service dependency and the new method:

```go
package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

// CatalogHandler serves a runtime's slice of the hub catalog, and accepts
// replayed projects a runtime created while the hub was unreachable.
type CatalogHandler struct {
	store   port.Store
	catalog *service.CatalogService
}

// NewCatalogHandler creates a catalog handler.
func NewCatalogHandler(s port.Store, catalog *service.CatalogService) *CatalogHandler {
	return &CatalogHandler{store: s, catalog: catalog}
}

// GetCatalog handles GET /api/runtime/catalog. The machine is taken from the
// request context (RequireMachineKey), never from a parameter.
func (h *CatalogHandler) GetCatalog(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	snap, err := h.store.CatalogForMachine(m.ID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// PostProject handles POST /api/runtime/projects — a runtime replaying a
// project it created locally while the hub was unreachable. machineId is
// never read from the body: it always comes from the authenticated caller.
func (h *CatalogHandler) PostProject(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId"`
		Name        string `json:"name"`
		Path        string `json:"path"`
		Repo        string `json:"repo"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.ID == "" || body.WorkspaceID == "" {
		writeErr(w, http.StatusBadRequest, "id and workspaceId are required")
		return
	}
	p, err := h.catalog.ReplayProject(m.ID, service.ReplayProjectRequest{
		ID:          body.ID,
		WorkspaceID: body.WorkspaceID,
		Name:        body.Name,
		Path:        body.Path,
		Repo:        body.Repo,
	})
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}
```

- [ ] **Step 9: Update the test helper and mount the route**

The `catalogRouter` test helper in `backend/internal/handler/catalog_test.go` (from Phase 2) constructs `NewCatalogHandler(st)` with one argument — update every call site in that file to pass a `*service.CatalogService`:

```go
func catalogRouter(st *store.Store) http.Handler {
	mux := http.NewServeMux()
	h := NewCatalogHandler(st, service.NewCatalogService(st))
	mux.HandleFunc("GET /api/runtime/catalog", h.GetCatalog)
	return RequireMachineKey(st)(mux)
}
```

In `backend/cmd/server/main.go`, find the existing nested-mux block that mounts `GET /api/runtime/catalog` (~line 450-455) and extend it:

```go
		catalogSvc := service.NewCatalogService(st)
		catalogH := handler.NewCatalogHandler(st, catalogSvc)
		catalogMux := http.NewServeMux()
		catalogMux.HandleFunc("GET /api/runtime/catalog", catalogH.GetCatalog)
		catalogMux.HandleFunc("POST /api/runtime/projects", catalogH.PostProject)
		mux.Handle("GET /api/runtime/catalog", handler.RequireMachineKey(st)(catalogMux))
		mux.Handle("POST /api/runtime/projects", handler.RequireMachineKey(st)(catalogMux))
```

(Two `mux.Handle` registrations sharing one `catalogMux` — Go's `http.ServeMux` dispatches by method+path within it, so this is the same pattern the existing `GET` line already uses, just extended to the new method+path.)

- [ ] **Step 10: Run the handler test to verify it passes**

```bash
cd backend && go test ./internal/handler/ -run TestPostProjectReplayScopesToPresentedMachineAndTranslates409 -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

Expected: PASS; full suite green.

- [ ] **Step 11: Commit**

```bash
git add backend/internal/store/catalog.go backend/internal/store/catalog_test.go \
        backend/internal/service/catalog.go backend/internal/handler/catalog.go \
        backend/internal/handler/catalog_test.go backend/internal/port/store.go \
        backend/cmd/server/main.go
git commit -m "feat(hub): accept replayed offline projects at POST /api/runtime/projects"
```

---

### Task 6: Make `ApplyCatalogSnapshot`'s project insert idempotent

**Files:**
- Modify: `backend/internal/store/catalog.go` (`ApplyCatalogSnapshot`)
- Test: `backend/internal/store/catalog_test.go`

**Interfaces:**
- Consumes: `ApplyCatalogSnapshot` (exists since Phase 2).
- Produces: no new signature — hardens existing behavior so Task 7's push-then-pull sequence can't crash the whole snapshot.

- [ ] **Step 1: Write the failing test**

This test reproduces the exact bug described at the top of this plan: mark a project synced (as Task 7's push step will), then apply a snapshot that includes that same project ID in the same tick — today's plain `INSERT` collides with it.

Append to `backend/internal/store/catalog_test.go`:

```go
func TestApplyCatalogSnapshotIsIdempotentForAJustReplayedProject(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, _ := s.CreateProject(ws.ID, "api", "/srv/api", "", "m-1")
	if err := s.MarkProjectLocal(p.ID); err != nil {
		t.Fatal(err)
	}
	// Simulate a successful replay: the push step flips origin back to hub
	// immediately, before the pull below applies a snapshot containing the
	// SAME project id (because the hub now legitimately has it too).
	if err := s.MarkProjectSynced(p.ID); err != nil {
		t.Fatal(err)
	}

	snap := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: ws.ID, Name: "clients"}},
		Projects:   []domain.Project{{ID: p.ID, WorkspaceID: ws.ID, Name: "api", Path: "/srv/api", MachineID: "m-1"}},
	}
	if err := s.ApplyCatalogSnapshot(snap, time.Unix(1_700_000_100, 0)); err != nil {
		t.Fatalf("ApplyCatalogSnapshot failed on a project id that already existed pre-flip: %v", err)
	}

	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin = %q, want hub", got.Origin)
	}
}

func TestApplyCatalogSnapshotAppliedTwiceInARowIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	snap := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: "ws-1", Name: "clients"}},
		Projects:   []domain.Project{{ID: "p-1", WorkspaceID: "ws-1", Name: "api", Path: "/srv/api", MachineID: "m-1"}},
	}
	if err := s.ApplyCatalogSnapshot(snap, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyCatalogSnapshot(snap, time.Unix(1_700_000_030, 0)); err != nil {
		t.Fatalf("applying the identical snapshot a second time failed: %v, want a clean no-op", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/store/ -run "TestApplyCatalogSnapshotIsIdempotentForAJustReplayedProject|TestApplyCatalogSnapshotAppliedTwiceInARowIsIdempotent" -v
```

Expected: the first test FAILS with a SQLite `UNIQUE constraint failed: projects.id` error — this is the exact bug. The second test currently passes already (the plain `DELETE FROM projects WHERE origin = 'hub'` step clears everything before each apply, so back-to-back identical snapshots happen not to collide) — that's fine, it's a regression guard for the fix, not proof of the bug.

- [ ] **Step 3: Make the insert idempotent**

In `backend/internal/store/catalog.go`, replace the project insert loop inside `ApplyCatalogSnapshot`:

```go
	for _, p := range snap.Projects {
		if _, err := tx.Exec(
			`INSERT INTO projects (id, workspace_id, name, repo, path, expanded, machine_id, origin)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'hub')
			 ON CONFLICT(id) DO UPDATE SET
			   workspace_id = excluded.workspace_id, name = excluded.name, repo = excluded.repo,
			   path = excluded.path, expanded = excluded.expanded, machine_id = excluded.machine_id,
			   origin = 'hub', sync_error = NULL`,
			p.ID, p.WorkspaceID, p.Name, p.Repo, p.Path, boolInt(p.Expanded), p.MachineID); err != nil {
			return err
		}
	}
```

This is deliberately unconditional (no `WHERE` clause on the conflict, unlike `ReplayLocalProject`): unlike a runtime-to-hub replay, a snapshot is always self-consistent data the hub itself already vouches for, so there's no "wrong machine" case to guard against here — just make repeated application safe.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/store/ -run "TestApplyCatalogSnapshotIsIdempotentForAJustReplayedProject|TestApplyCatalogSnapshotAppliedTwiceInARowIsIdempotent" -v
cd backend && go test ./internal/... && go vet ./...
```

Expected: both PASS; full suite green, including the Phase 2 snapshot tests (`TestApplyCatalogSnapshotPreservesLocalProjectsAndWorktrees`, `TestApplyCatalogSnapshotRollsBackOnFailure`) which must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/store/catalog.go backend/internal/store/catalog_test.go
git commit -m "fix(store): make ApplyCatalogSnapshot's project insert idempotent"
```

---

### Task 7: Runtime pushes local projects before pulling

**Files:**
- Modify: `backend/internal/machineclient/catalog.go` (`ReplayProject` client call)
- Modify: `backend/internal/service/sync.go` (`syncOnce`)
- Test: `backend/internal/machineclient/catalog_test.go`, `backend/internal/service/sync_test.go` (create)

**Interfaces:**
- Consumes: `LocalProjects`, `MarkProjectSynced`, `SetProjectSyncError` (Task 2); `POST /api/runtime/projects` (Task 5).
- Produces: `machineclient.ReplayProject(ctx, hubURL, machineKey string, p domain.Project) (domain.Project, error)`, `machineclient.ErrWorkspaceGone` (sentinel for the 409 case).

- [ ] **Step 1: Write the failing client test**

Append to `backend/internal/machineclient/catalog_test.go`:

```go
func TestReplayProjectSendsProjectAndDecodesResult(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"p-1","name":"api","path":"/srv/api","workspaceId":"ws-1","machineId":"m-a","origin":"hub"}`))
	}))
	defer srv.Close()

	p := domain.Project{ID: "p-1", WorkspaceID: "ws-1", Name: "api", Path: "/srv/api"}
	got, err := ReplayProject(context.Background(), srv.URL, "rt-key", p)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin = %q, want hub (the hub's response)", got.Origin)
	}
	if !strings.Contains(string(gotBody), `"id":"p-1"`) || !strings.Contains(string(gotBody), `"workspaceId":"ws-1"`) {
		t.Errorf("request body = %s, want it to carry id and workspaceId", gotBody)
	}
	if strings.Contains(string(gotBody), "machineId") {
		t.Errorf("request body = %s, must NOT include machineId — the hub derives it from the caller's key", gotBody)
	}
}

func TestReplayProjectReturnsErrWorkspaceGoneOn409(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"workspace does not exist"}`))
	}))
	defer srv.Close()

	_, err := ReplayProject(context.Background(), srv.URL, "rt-key", domain.Project{ID: "p-1", WorkspaceID: "ws-gone"})
	if !errors.Is(err, ErrWorkspaceGone) {
		t.Errorf("error = %v, want ErrWorkspaceGone", err)
	}
}
```

Add `"errors"`, `"io"`, `"strings"` to the file's imports if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/machineclient/ -run "TestReplayProject"
```

Expected: FAIL — `undefined: ReplayProject`, `undefined: ErrWorkspaceGone`.

- [ ] **Step 3: Implement the client call**

Append to `backend/internal/machineclient/catalog.go`:

```go
// ErrWorkspaceGone means the hub rejected a replayed project because its
// workspace no longer exists there. Distinct from a transient network/5xx
// failure: the caller should record why, not just retry silently forever.
var ErrWorkspaceGone = errors.New("workspace no longer exists on the hub")

type replayProjectBody struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Repo        string `json:"repo"`
}

// ReplayProject pushes one project this runtime created while the hub was
// unreachable. Like FetchCatalog, it authenticates with the runtime's own
// key; machineId is never sent — the hub derives it from that key.
func ReplayProject(ctx context.Context, hubURL, machineKey string, p domain.Project) (domain.Project, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	body, err := json.Marshal(replayProjectBody{
		ID:          p.ID,
		WorkspaceID: p.WorkspaceID,
		Name:        p.Name,
		Path:        p.Path,
		Repo:        p.Repo,
	})
	if err != nil {
		return domain.Project{}, err
	}

	url := strings.TrimRight(hubURL, "/") + "/api/runtime/projects"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return domain.Project{}, err
	}
	req.Header.Set("Authorization", "Bearer "+machineKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return domain.Project{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return domain.Project{}, ErrWorkspaceGone
	}
	if resp.StatusCode != http.StatusOK {
		return domain.Project{}, fmt.Errorf("hub returned status %d for POST %s", resp.StatusCode, url)
	}

	var got domain.Project
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		return domain.Project{}, fmt.Errorf("decode replayed project: %w", err)
	}
	return got, nil
}
```

Add `"bytes"` and `"errors"` to the file's imports.

- [ ] **Step 4: Run the client tests to verify they pass**

```bash
cd backend && go test ./internal/machineclient/ -run "TestReplayProject" -v
```

Expected: both PASS.

- [ ] **Step 5: Write the failing sync-loop test**

Create `backend/internal/service/sync_test.go`:

```go
package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"devdeck/backend/internal/store"
)

func TestSyncOnceReplaysLocalProjectsBeforePulling(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	local, _ := st.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := st.MarkProjectLocal(local.ID); err != nil {
		t.Fatal(err)
	}

	var sawReplay, sawPull bool
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runtime/projects":
			sawReplay = true
			_, _ = w.Write([]byte(`{"id":"` + local.ID + `","name":"api","path":"/srv/api","workspaceId":"` + ws.ID + `","machineId":"m-a","origin":"hub"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/runtime/catalog":
			sawPull = true
			_, _ = w.Write([]byte(`{"workspaces":[{"id":"` + ws.ID + `","name":"clients"}],"projects":[{"id":"` + local.ID + `","name":"api","path":"/srv/api","workspaceId":"` + ws.ID + `","machineId":"m-a"}],"sshConnections":[]}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer hub.Close()

	RunSyncLoop(context.Background(), st, SyncConfig{HubURL: hub.URL, MachineKey: "rt-key"}, time.Hour)
	// RunSyncLoop's first tick runs synchronously before waiting on the
	// ticker, so by the time it would block, syncOnce has already run once.

	if !sawReplay || !sawPull {
		t.Fatalf("sawReplay=%v sawPull=%v, want both true", sawReplay, sawPull)
	}
	got, err := st.ProjectByID(local.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin after a successful sync cycle = %q, want hub", got.Origin)
	}
}
```

Note: `RunSyncLoop` runs forever — this test relies on it running its first tick synchronously and then blocking on a one-hour ticker, which never fires within the test, so the test process would hang. **Do not call `RunSyncLoop` directly here.** Replace the call with a package-private test seam instead — see Step 6.

- [ ] **Step 6: Run it to verify it fails, then fix the test to avoid hanging**

```bash
cd backend && go test ./internal/service/ -run TestSyncOnceReplaysLocalProjectsBeforePulling -timeout 5s
```

Expected: the test as written above will TIME OUT (it calls the forever-looping `RunSyncLoop`). Fix the test itself to call the package-private `syncOnce` directly instead, which is exactly what Step 8's implementation exposes for exactly this reason. Replace the `RunSyncLoop(...)` call with:

```go
	syncOnce(context.Background(), st, SyncConfig{HubURL: hub.URL, MachineKey: "rt-key"})
```

Re-run:

```bash
cd backend && go test ./internal/service/ -run TestSyncOnceReplaysLocalProjectsBeforePulling -timeout 5s
```

Expected: FAIL — `sawReplay=false` (today's `syncOnce` only pulls, per Phase 2 — it has no push step yet).

- [ ] **Step 7: Implement the push step**

Replace `syncOnce` in `backend/internal/service/sync.go`:

```go
func syncOnce(ctx context.Context, st port.Store, cfg SyncConfig) {
	pushLocalProjects(ctx, st, cfg)

	snap, err := machineclient.FetchCatalog(ctx, cfg.HubURL, cfg.MachineKey)
	if err != nil {
		log.Printf("catalog sync: fetch: %v", err)
		return
	}
	if err := st.ApplyCatalogSnapshot(snap, time.Now()); err != nil {
		log.Printf("catalog sync: apply: %v", err)
		return
	}
	log.Printf("catalog sync: %d workspace(s), %d project(s), %d ssh connection(s)",
		len(snap.Workspaces), len(snap.Projects), len(snap.SSHConnections))
}

// pushLocalProjects replays every project created while the hub was
// unreachable. Runs before the pull below: a project accepted here should
// come back as a hub row in the SAME cycle's snapshot, never appearing
// twice. A push failure is logged and left for the next tick — it never
// blocks the pull, since a stale replica is still better than none.
func pushLocalProjects(ctx context.Context, st port.Store, cfg SyncConfig) {
	local, err := st.LocalProjects()
	if err != nil {
		log.Printf("catalog sync: list local projects: %v", err)
		return
	}
	for _, p := range local {
		_, err := machineclient.ReplayProject(ctx, cfg.HubURL, cfg.MachineKey, p)
		switch {
		case err == nil:
			// Flip to origin=hub NOW, before the pull below applies a
			// snapshot containing this same project id — ApplyCatalogSnapshot
			// only deletes origin='hub' rows before reinserting, so a row
			// still marked 'local' at that point would collide with the
			// snapshot's copy on its own primary key.
			if err := st.MarkProjectSynced(p.ID); err != nil {
				log.Printf("catalog sync: mark %s synced: %v", p.ID, err)
			}
		case errors.Is(err, machineclient.ErrWorkspaceGone):
			if err := st.SetProjectSyncError(p.ID, "this project's workspace no longer exists on the hub"); err != nil {
				log.Printf("catalog sync: record sync error for %s: %v", p.ID, err)
			}
		default:
			log.Printf("catalog sync: replay %s: %v", p.ID, err)
		}
	}
}
```

Add `"errors"` to the file's imports.

- [ ] **Step 8: Run the test to verify it passes**

```bash
cd backend && go test ./internal/service/ -run TestSyncOnceReplaysLocalProjectsBeforePulling -v -timeout 5s
cd backend && go test ./internal/... && go vet ./...
```

Expected: PASS; full suite green.

- [ ] **Step 9: Commit**

```bash
git add backend/internal/machineclient/catalog.go backend/internal/machineclient/catalog_test.go \
        backend/internal/service/sync.go backend/internal/service/sync_test.go
git commit -m "feat(runtime): replay local projects to the hub before each catalog pull"
```

---

### Task 8: Frontend — show sync state on a project row

**Files:**
- Create: `frontend/src/features/sidebar/ProjectSyncBadge.tsx`
- Modify: `frontend/src/features/sidebar/ProjectTree.tsx`

**Interfaces:**
- Consumes: `Project.origin`, `Project.syncError` (Task 1), `useWhoami()` (exists since Phase 1).
- Produces: `ProjectSyncBadge` component, rendered per project row.

- [ ] **Step 1: Check the real CSS tokens before writing markup**

```bash
grep -n "devdeck-warn\|devdeck-dim\|devdeck-muted\|devdeck-fg" frontend/src/styles/globals.css
```

Use whatever token names that prints — do not invent new ones. If there is no warning/amber token, reuse `devdeck-dim`/`devdeck-muted` for the "pending" state and fall back to an existing error/red token (search for one, e.g. `devdeck-danger` or similar) for the "won't sync" state; if none exists, use `text-red-400` (Tailwind default) rather than inventing a CSS variable.

- [ ] **Step 2: Create the badge component**

Create `frontend/src/features/sidebar/ProjectSyncBadge.tsx`:

```tsx
import { CloudUpload, TriangleAlert } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import type { Project } from '@/store/types'

/**
 * Only rendered on a runtime (a hub's own projects are always origin="hub").
 * Distinguishes "created here, hasn't replayed yet" from "will never replay
 * as-is" — both look identical as plain rows otherwise, and the second one
 * silently retries forever unless the operator notices and recreates the
 * project under a workspace that still exists.
 */
export function ProjectSyncBadge({ project }: { project: Project }) {
  if (project.origin !== 'local') return null

  if (project.syncError) {
    return (
      <Tooltip content={project.syncError}>
        <TriangleAlert size={12} strokeWidth={2} className="shrink-0 text-red-400" />
      </Tooltip>
    )
  }
  return (
    <Tooltip content="Created on this runtime, not yet synced to the hub">
      <CloudUpload size={12} strokeWidth={2} className="shrink-0 text-devdeck-dim" />
    </Tooltip>
  )
}
```

Confirm the `Tooltip` component's real prop name (`content`) before writing this — check `frontend/src/components/ui/tooltip.tsx`'s exported props, and adjust if the actual prop is named differently.

- [ ] **Step 3: Render it in ProjectTree**

Open `frontend/src/features/sidebar/ProjectTree.tsx` and find the project row's rendering — the line that renders `<Folder .../>` or the project name label — and add the badge next to it. Import at the top:

```tsx
import { ProjectSyncBadge } from './ProjectSyncBadge'
```

In the row's JSX, add `<ProjectSyncBadge project={project} />` immediately after the project name/label element within that row (read the surrounding JSX first — `ProjectTree.tsx` already destructures `project` in its `.map()` callback, so `project` is in scope; place the badge so it doesn't break the existing flex layout — check whether the row is a flex container and add `gap` spacing consistent with neighboring icons like `WorktreeGlyph`).

- [ ] **Step 4: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/sidebar/ProjectSyncBadge.tsx frontend/src/features/sidebar/ProjectTree.tsx
git commit -m "feat(runtime): show pending/failed sync state on a project row"
```

---

### Task 9: End-to-end verification

No new code — this task proves Tasks 1-8 work together against real processes, the way Phase 1-2's plan did.

- [ ] **Step 1: Build**

```bash
cd backend && go build -o /tmp/devdeck-server-p3 ./cmd/server && go test ./... && go vet ./...
cd ../frontend && npm run typecheck && npm run build
```

- [ ] **Step 2: Offline create → replay → origin flips to hub**

```bash
rm -f /tmp/hub-p3.db* /tmp/rt-p3.db*
/tmp/devdeck-server-p3 --role hub --key hubkey --2fa=false --addr 127.0.0.1:19970 --db /tmp/hub-p3.db --open=false &
sleep 2
WS_ID=$(curl -s -X POST -H "Authorization: Bearer hubkey" -H "Content-Type: application/json" -d '{"name":"clients"}' http://127.0.0.1:19970/api/workspaces | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "workspace: $WS_ID"

# Runtime starts with NO --hub-url, so the create below happens while genuinely offline.
/tmp/devdeck-server-p3 --role runtime --key rtkey --addr 127.0.0.1:19971 --db /tmp/rt-p3.db --open=false --name offline-box &
sleep 2

# The runtime doesn't know this workspace exists yet (never synced), so
# create it locally too, matching what the UI would show after a first pull.
# For this smoke test, seed the runtime's replica directly via its own store
# is not exposed over HTTP — instead, point it at the hub now so it pulls
# the workspace, THEN take the hub down again to test the offline-create path.
kill %2
/tmp/devdeck-server-p3 --role runtime --key rtkey --addr 127.0.0.1:19971 --db /tmp/rt-p3.db --open=false --name offline-box \
  --hub-url http://127.0.0.1:19970 --hub-key hubkey --public-url http://127.0.0.1:19971 &
sleep 3
curl -s -H "Authorization: Bearer rtkey" http://127.0.0.1:19971/api/workspaces
echo ""

# Now take the hub down — everything from here happens genuinely offline.
kill %1
sleep 1
PID=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:19970/api/health); echo "hub reachable: $PID (want 000)"

PROJECT=$(curl -s -X POST -H "Authorization: Bearer rtkey" -H "Content-Type: application/json" \
  -d '{"name":"api","path":"/srv/api"}' "http://127.0.0.1:19971/api/workspaces/$WS_ID/projects")
echo "created offline: $PROJECT"
echo "$PROJECT" | grep -o '"origin":"[^"]*"'
```

Expected: the created project's JSON shows `"origin":"local"`.

- [ ] **Step 3: Bring the hub back, confirm replay within one sync tick**

```bash
/tmp/devdeck-server-p3 --role hub --key hubkey --2fa=false --addr 127.0.0.1:19970 --db /tmp/hub-p3.db --open=false &
sleep 35   # one full 30s sync tick, plus margin

curl -s -H "Authorization: Bearer rtkey" http://127.0.0.1:19971/api/workspaces | grep -o '"origin":"[^"]*"'
curl -s -H "Authorization: Bearer hubkey" http://127.0.0.1:19970/api/workspaces
```

Expected: the runtime's copy now shows `"origin":"hub"`, and the hub's own `/api/workspaces` shows the same project under the same workspace, with the same project ID the runtime originally minted.

- [ ] **Step 4: The 409 case — workspace deleted before replay**

```bash
WS2_ID=$(curl -s -X POST -H "Authorization: Bearer hubkey" -H "Content-Type: application/json" -d '{"name":"doomed"}' http://127.0.0.1:19970/api/workspaces | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
sleep 35  # let the runtime pull the new workspace down

kill %2   # hub down again
sleep 1
PROJECT2=$(curl -s -X POST -H "Authorization: Bearer rtkey" -H "Content-Type: application/json" \
  -d '{"name":"orphan","path":"/srv/orphan"}' "http://127.0.0.1:19971/api/workspaces/$WS2_ID/projects")
PROJECT2_ID=$(echo "$PROJECT2" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X DELETE -H "Authorization: Bearer hubkey" "http://127.0.0.1:19970/api/workspaces" > /dev/null 2>&1 || true
# Delete the doomed workspace on the hub while it's briefly back up for this one call:
/tmp/devdeck-server-p3 --role hub --key hubkey --2fa=false --addr 127.0.0.1:19970 --db /tmp/hub-p3.db --open=false &
sleep 2
curl -s -X DELETE -H "Authorization: Bearer hubkey" "http://127.0.0.1:19970/api/workspaces/$WS2_ID"

sleep 35  # let the runtime try to replay the orphaned project and get 409

curl -s -H "Authorization: Bearer rtkey" "http://127.0.0.1:19971/api/workspaces/$WS2_ID/projects" 2>/dev/null
curl -s -H "Authorization: Bearer rtkey" http://127.0.0.1:19971/api/workspaces | grep -A2 "\"id\":\"$PROJECT2_ID\""
```

Expected: the project is still present in the runtime's own `/api/workspaces` response with `"origin":"local"` and a non-null `"syncError"`, and the runtime's log (`tail` the process output) shows no crash — just a logged replay failure each tick.

- [ ] **Step 5: DELETE gating**

```bash
# Deleting the still-local, never-synced project must succeed on the runtime.
curl -s -o /dev/null -w "delete-local=%{http_code}\n" -X DELETE -H "Authorization: Bearer rtkey" "http://127.0.0.1:19971/api/projects/$PROJECT2_ID"

# Deleting the already-synced project (from Step 3) must be REJECTED on the runtime.
SYNCED_ID=$(curl -s -H "Authorization: Bearer rtkey" http://127.0.0.1:19971/api/workspaces | grep -o '"id":"p-[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -o /dev/null -w "delete-synced-on-runtime=%{http_code}\n" -X DELETE -H "Authorization: Bearer rtkey" "http://127.0.0.1:19971/api/projects/$SYNCED_ID"

# The SAME project, deleted from the hub, must succeed (hub is unrestricted).
curl -s -o /dev/null -w "delete-synced-on-hub=%{http_code}\n" -X DELETE -H "Authorization: Bearer hubkey" "http://127.0.0.1:19970/api/projects/$SYNCED_ID"
```

Expected: `delete-local=204`, `delete-synced-on-runtime=403`, `delete-synced-on-hub=204`.

- [ ] **Step 6: Clean up**

```bash
kill %1 %2 2>/dev/null
pkill -f devdeck-server-p3 2>/dev/null
rm -f /tmp/hub-p3.db* /tmp/rt-p3.db* /tmp/devdeck-server-p3
```

## Definition of done for Phase 3

- [ ] `go test ./...` passes, `go vet ./...` silent, `npm run typecheck` and `npm run build` succeed
- [ ] A project created on a runtime with no reachable hub is marked `origin: "local"` in its API response
- [ ] Once the hub is reachable, the sync loop replays it within one tick, and it becomes `origin: "hub"` on both sides with its ID unchanged
- [ ] `ApplyCatalogSnapshot` applied twice in a row, or applied right after `MarkProjectSynced` for a project the snapshot also contains, never errors
- [ ] A project whose workspace was deleted on the hub before replay gets a `409`, stays `origin: "local"` with a `syncError` set, and is never deleted or hidden
- [ ] `DELETE /api/projects/{id}` on a runtime succeeds only for `origin: "local"` rows (403 otherwise); the hub can still delete anything
- [ ] The frontend shows a distinct indicator for "pending" vs. "won't sync" project rows, visible only on a runtime

## Out of scope (later phases)

Phase 4 (Ed25519 hub-signed handover token), Phase 5 (SSH secrets + `host_key_fingerprint` move to the runtime), Phase 6 (route cleanup — gating PATCH on hub-only, removing the now-dead invoice/news/todo/etc. routes from runtimes, UI role gating for Machines/Invoices/etc.).
