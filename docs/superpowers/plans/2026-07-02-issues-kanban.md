# Issues: Per-Project Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project `Issue` resource with a drag-and-drop kanban board, a routed issue-detail page, and markdown-rendered descriptions, following the design in `docs/superpowers/specs/2026-07-02-issues-kanban-design.md`.

**Architecture:** New domain resource `Issue` (title, markdown `description`, `status`, `priority`, `assignee`, sortable `position`), nested under `Project` exactly like `Worktree` is today. Backend follows the plain-CRUD pattern used by `Todo`/`Invoice`/`News` (handler calls `*store.Store` directly, no service layer). Frontend adds a `features/issues/` module, two new routes under a project, and a small tab switcher in the existing project layout.

**Tech Stack:** Go 1.25 stdlib `net/http` + SQLite (existing backend stack, no new backend deps). Frontend adds `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (kanban drag-and-drop) and `react-markdown`, `remark-gfm` (read-only markdown rendering).

## Global Constraints

- Domain types are added to **both** `frontend/src/store/types.ts` and `backend/internal/domain/models.go` in the same task, with matching JSON keys (`CONTRACTS.md`).
- API error responses stay exactly `{"error": "<message>"}` — never add `success`/`data`/`code` fields (`CONTRACTS.md`).
- All persistence goes through `port.Store` / `*store.Store` — no raw SQL outside `internal/store/` (`CONTRACTS.md`).
- Go handlers use `handleStoreErr(w, err)`; never return a raw SQL/database error to the client (`CONTRACTS.md`).
- Patch structs use `*T` pointer fields for optional updates; nullable fields (like `Assignee`) get a `Has*` bool to distinguish "absent" from "explicit null" (`CONTRACTS.md`).
- Frontend imports from `src/` use the `@/*` alias, never relative paths (`CONTRACTS.md`, `.claude/rules/frontend.md`).
- `verbatimModuleSyntax` is on — use `import type` for type-only imports (`CONTRACTS.md`).
- Never hand-edit `frontend/src/routeTree.gen.ts` — it regenerates from route files automatically via the Vite plugin (`CLAUDE.md`, `COMMANDS.md`).
- IDs are type-prefixed hex generated via `idGen(prefix)`; this feature uses prefix `is-` (`.claude/rules/go.md`).
- Run `npm run typecheck` (frontend) and `go vet ./...` (backend) before committing (`.claude/rules/frontend.md`, `.claude/rules/go.md`).

---

### Task 1: Domain model + SQLite schema

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/store/db.go`

**Interfaces:**
- Produces: `domain.Issue` struct and `domain.Project.Issues []Issue` field, plus a new `issues` SQLite table. Both are consumed by every later backend task.

- [ ] **Step 1: Add the `Issue` struct and `Project.Issues` field**

In `backend/internal/domain/models.go`, add this new type right after the `Project` struct (after line 39, the closing `}` of `Project`):

```go
// Issue mirrors the frontend Issue type.
type Issue struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Priority    string  `json:"priority"`
	Assignee    *string `json:"assignee"`
	Position    float64 `json:"position"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	ProjectID   string  `json:"-"` // internal use, not exposed to frontend — matches Worktree.ProjectID
}
```

Then add an `Issues` field to the existing `Project` struct so it reads:

```go
// Project mirrors the frontend Project type.
type Project struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Repo      string     `json:"repo"`
	Path      string     `json:"path"`
	Expanded  bool       `json:"expanded"`
	Worktrees []Worktree `json:"worktrees"`
	Issues    []Issue    `json:"issues"`
}
```

- [ ] **Step 2: Add the `issues` table to the schema**

In `backend/internal/store/db.go`, insert this block into the `schema` const, right after the `worktrees` table + its index (after line 48, `CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);`):

```sql
CREATE TABLE IF NOT EXISTS issues (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo',
  priority    TEXT NOT NULL DEFAULT 'normal',
  assignee    TEXT,
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
```

This is a brand-new table, so `CREATE TABLE IF NOT EXISTS` alone is enough for both fresh and pre-existing databases — no `ALTER TABLE` migration function needed (unlike columns added to an already-existing table, e.g. `migrateWorktreeColumns`).

- [ ] **Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: exits with no output (success). This step only adds types and a schema string, so there's no behavior to unit-test yet — Task 2 exercises this table.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go
git commit -m "feat: add Issue domain type and issues table"
```

---

### Task 2: Issue store — interface, patch type, SQLite implementation, tests

**Files:**
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/store/issue.go`
- Modify: `backend/internal/store/project.go`
- Create: `backend/internal/store/issue_test.go`

**Interfaces:**
- Consumes: `domain.Issue`, `domain.Project.Issues` (Task 1).
- Produces: `Store.CreateIssue(projectID, title, status, createdAt string) (domain.Issue, error)`, `Store.UpdateIssue(id, updatedAt string, p port.IssuePatch) (domain.Issue, error)`, `Store.DeleteIssue(id string) error`, `port.IssuePatch{Title, Description, Status, Priority *string; Position *float64; Assignee *string; HasAssignee bool}`. Consumed by Task 3 (handler).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/store/issue_test.go`:

```go
package store

import (
	"testing"

	"loom/backend/internal/port"
)

func TestCreateIssueDefaultsStatusAndPosition(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	if err != nil {
		t.Fatal(err)
	}

	iss, err := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if iss.Status != "todo" {
		t.Errorf("CreateIssue with blank status = %q, want default %q", iss.Status, "todo")
	}
	if iss.Priority != "normal" {
		t.Errorf("CreateIssue priority = %q, want default %q", iss.Priority, "normal")
	}
	if iss.Position != 0 {
		t.Errorf("first issue in an empty column: Position = %v, want 0", iss.Position)
	}
	if iss.Assignee != nil {
		t.Errorf("CreateIssue Assignee = %v, want nil", iss.Assignee)
	}

	iss2, err := s.CreateIssue(proj.ID, "Second issue", "", "2026-07-02T10:05:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if iss2.Position != 1 {
		t.Errorf("second issue in the same column: Position = %v, want 1", iss2.Position)
	}

	proj, err = s.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(proj.Issues) != 2 {
		t.Errorf("ProjectByID().Issues = %+v, want 2 entries", proj.Issues)
	}
}

func TestUpdateIssueMovesColumnAndPosition(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, err := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}

	newStatus := "in_progress"
	newPos := 2.5
	updated, err := s.UpdateIssue(iss.ID, "2026-07-02T11:00:00Z", port.IssuePatch{
		Status:   &newStatus,
		Position: &newPos,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != "in_progress" {
		t.Errorf("UpdateIssue Status = %q, want %q", updated.Status, "in_progress")
	}
	if updated.Position != 2.5 {
		t.Errorf("UpdateIssue Position = %v, want 2.5", updated.Position)
	}
	if updated.Title != "Fix login bug" {
		t.Errorf("UpdateIssue changed Title to %q, want it unchanged", updated.Title)
	}
	if updated.UpdatedAt != "2026-07-02T11:00:00Z" {
		t.Errorf("UpdateIssue UpdatedAt = %q, want %q", updated.UpdatedAt, "2026-07-02T11:00:00Z")
	}
}

func TestUpdateIssueAssigneeNullableClear(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	name := "kiyora"
	updated, err := s.UpdateIssue(iss.ID, "2026-07-02T11:00:00Z", port.IssuePatch{
		Assignee:    &name,
		HasAssignee: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Assignee == nil || *updated.Assignee != "kiyora" {
		t.Errorf("UpdateIssue Assignee = %v, want %q", updated.Assignee, "kiyora")
	}

	cleared, err := s.UpdateIssue(iss.ID, "2026-07-02T12:00:00Z", port.IssuePatch{
		Assignee:    nil,
		HasAssignee: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Assignee != nil {
		t.Errorf("UpdateIssue with HasAssignee+nil Assignee = %v, want nil (explicit clear)", cleared.Assignee)
	}
}

func TestDeleteIssueRemovesIt(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	if err := s.DeleteIssue(iss.ID); err != nil {
		t.Fatal(err)
	}
	proj, err := s.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(proj.Issues) != 0 {
		t.Errorf("Project.Issues after delete = %+v, want empty", proj.Issues)
	}
	if err := s.DeleteIssue(iss.ID); err != ErrNotFound {
		t.Errorf("DeleteIssue on already-deleted id = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/store/... -run TestCreateIssue -v`
Expected: FAIL — compile error, `s.CreateIssue` undefined (method doesn't exist yet).

- [ ] **Step 3: Add `CreateIssue`/`UpdateIssue`/`DeleteIssue` and `IssuePatch` to the `Store` interface**

In `backend/internal/port/store.go`, add to the `Store` interface (after the `Worktrees` block, before `// Todos`):

```go
	// Issues
	CreateIssue(projectID, title, status, createdAt string) (domain.Issue, error)
	UpdateIssue(id, updatedAt string, p IssuePatch) (domain.Issue, error)
	DeleteIssue(id string) error
```

And add this patch type at the end of the file, after `NewsPatch`:

```go
// IssuePatch carries optional fields for a partial issue update.
type IssuePatch struct {
	Title       *string
	Description *string
	Status      *string
	Priority    *string
	Position    *float64
	Assignee    *string
	HasAssignee bool // true when the JSON key "assignee" was present (allows explicit null)
}
```

- [ ] **Step 4: Implement the store methods**

Create `backend/internal/store/issue.go`:

```go
package store

import (
	"database/sql"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

func (s *Store) issuesOf(projectID string) ([]domain.Issue, error) {
	rows, err := s.db.Query(
		`SELECT id, project_id, title, description, status, priority, assignee, position, created_at, updated_at
		 FROM issues WHERE project_id = ? ORDER BY position ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Issue{}
	for rows.Next() {
		iss, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, iss)
	}
	return out, rows.Err()
}

func (s *Store) issueByID(id string) (domain.Issue, error) {
	row := s.db.QueryRow(
		`SELECT id, project_id, title, description, status, priority, assignee, position, created_at, updated_at
		 FROM issues WHERE id = ?`, id)
	iss, err := scanIssue(row)
	if err != nil {
		return domain.Issue{}, mapNotFound(err)
	}
	return iss, nil
}

func scanIssue(sc scanner) (domain.Issue, error) {
	var iss domain.Issue
	var assignee sql.NullString
	err := sc.Scan(&iss.ID, &iss.ProjectID, &iss.Title, &iss.Description, &iss.Status, &iss.Priority,
		&assignee, &iss.Position, &iss.CreatedAt, &iss.UpdatedAt)
	if err != nil {
		return iss, err
	}
	if assignee.Valid {
		a := assignee.String
		iss.Assignee = &a
	}
	return iss, nil
}

// CreateIssue creates an issue at the end of its status column (position =
// max existing position in that (project, status) pair + 1, or 0 if empty).
func (s *Store) CreateIssue(projectID, title, status, createdAt string) (domain.Issue, error) {
	if _, err := s.ProjectByID(projectID); err != nil {
		return domain.Issue{}, err
	}
	if status == "" {
		status = "todo"
	}
	var maxPos sql.NullFloat64
	if err := s.db.QueryRow(
		`SELECT MAX(position) FROM issues WHERE project_id = ? AND status = ?`, projectID, status,
	).Scan(&maxPos); err != nil {
		return domain.Issue{}, err
	}
	position := 0.0
	if maxPos.Valid {
		position = maxPos.Float64 + 1
	}
	id := idGen("is-")
	if _, err := s.db.Exec(
		`INSERT INTO issues (id, project_id, title, description, status, priority, assignee, position, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, 'normal', NULL, ?, ?, ?)`,
		id, projectID, title, status, position, createdAt, createdAt,
	); err != nil {
		return domain.Issue{}, err
	}
	return s.issueByID(id)
}

// UpdateIssue applies a partial patch. Status+Position together is how a
// kanban drag-and-drop move is expressed — the client computes both.
func (s *Store) UpdateIssue(id, updatedAt string, p port.IssuePatch) (domain.Issue, error) {
	if _, err := s.issueByID(id); err != nil {
		return domain.Issue{}, err
	}
	if err := firstErr(
		setStr(s.db, "issues", "title", id, p.Title),
		setStr(s.db, "issues", "description", id, p.Description),
		setStr(s.db, "issues", "status", id, p.Status),
		setStr(s.db, "issues", "priority", id, p.Priority),
	); err != nil {
		return domain.Issue{}, err
	}
	if p.Position != nil {
		if _, err := s.db.Exec(`UPDATE issues SET position = ? WHERE id = ?`, *p.Position, id); err != nil {
			return domain.Issue{}, err
		}
	}
	if p.HasAssignee {
		if _, err := s.db.Exec(`UPDATE issues SET assignee = ? WHERE id = ?`, p.Assignee, id); err != nil {
			return domain.Issue{}, err
		}
	}
	if _, err := s.db.Exec(`UPDATE issues SET updated_at = ? WHERE id = ?`, updatedAt, id); err != nil {
		return domain.Issue{}, err
	}
	return s.issueByID(id)
}

// DeleteIssue deletes an issue.
func (s *Store) DeleteIssue(id string) error {
	res, err := s.db.Exec(`DELETE FROM issues WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 5: Wire issues into `projectsOf` and `ProjectByID`**

In `backend/internal/store/project.go`, modify `projectsOf` so the loop that attaches worktrees also attaches issues (replace the existing loop body):

```go
	for i := range out {
		wts, err := s.worktreesOf(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Worktrees = wts
		iss, err := s.issuesOf(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Issues = iss
	}
```

And modify `ProjectByID` so it also loads issues (replace the existing body after the `Scan` call):

```go
func (s *Store) ProjectByID(id string) (domain.Project, error) {
	var p domain.Project
	err := s.db.QueryRow(`SELECT id, name, repo, path, expanded FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Repo, &p.Path, &p.Expanded)
	if err != nil {
		return domain.Project{}, mapNotFound(err)
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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/store/... -run 'TestCreateIssue|TestUpdateIssue|TestDeleteIssue' -v`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Run the full backend test suite and vet**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all pass — this also confirms `*store.Store` still satisfies `port.Store` everywhere it's used as that interface (e.g. `service.NewProjectService(st)` in `main.go`).

- [ ] **Step 8: Commit**

```bash
git add backend/internal/port/store.go backend/internal/store/issue.go backend/internal/store/issue_test.go backend/internal/store/project.go
git commit -m "feat: implement Issue store (create/update/delete, nested under Project)"
```

---

### Task 3: Issue HTTP handler

**Files:**
- Create: `backend/internal/handler/issue.go`

**Interfaces:**
- Consumes: `Store.CreateIssue`, `Store.UpdateIssue`, `Store.DeleteIssue`, `port.IssuePatch` (Task 2); `str(*string) string` and `handleStoreErr`/`writeJSON`/`writeErr`/`decodeBody` (existing helpers in `backend/internal/handler/`).
- Produces: `IssueHandler` with `PostIssue`, `PatchIssue`, `DeleteIssue` methods, and `NewIssueHandler(st *store.Store) *IssueHandler`. Consumed by Task 4 (`main.go`).

- [ ] **Step 1: Write the handler**

Create `backend/internal/handler/issue.go`:

```go
package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// IssueHandler handles issue CRUD endpoints.
type IssueHandler struct {
	st *store.Store
}

// NewIssueHandler creates an issue handler.
func NewIssueHandler(st *store.Store) *IssueHandler {
	return &IssueHandler{st: st}
}

// PostIssue creates an issue under a project.
func (h *IssueHandler) PostIssue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title  string  `json:"title"`
		Status *string `json:"status"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	createdAt := time.Now().UTC().Format(time.RFC3339)
	iss, err := h.st.CreateIssue(r.PathValue("projectId"), body.Title, str(body.Status), createdAt)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iss)
}

// PatchIssue updates an issue's fields (also used for kanban drag-and-drop moves).
func (h *IssueHandler) PatchIssue(w http.ResponseWriter, r *http.Request) {
	var p port.IssuePatch
	raw, err := decodeBody(r, &p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, ok := raw["assignee"]; ok {
		p.HasAssignee = true
	}
	updatedAt := time.Now().UTC().Format(time.RFC3339)
	iss, err := h.st.UpdateIssue(r.PathValue("id"), updatedAt, p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iss)
}

// DeleteIssue deletes an issue.
func (h *IssueHandler) DeleteIssue(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteIssue(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: exits with no output. There's no dedicated handler test file for any of the plain-CRUD resources (`Todo`, `Invoice`, `News`) in this codebase — Task 4's manual curl pass is the verification for this layer, matching that precedent.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/handler/issue.go
git commit -m "feat: add Issue HTTP handler"
```

---

### Task 4: Wire routes in `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `handler.NewIssueHandler(st)` (Task 3).

- [ ] **Step 1: Instantiate the handler**

In `backend/cmd/server/main.go`, add this line after `newsH := handler.NewNewsHandler(st)` (line 58):

```go
	issueH := handler.NewIssueHandler(st)
```

- [ ] **Step 2: Register the routes**

Add this block after the worktree routes (after line 85, `mux.HandleFunc("DELETE /api/worktrees/{id}", wtH.DeleteWorktree)`):

```go
	mux.HandleFunc("POST /api/projects/{projectId}/issues", issueH.PostIssue)
	mux.HandleFunc("PATCH /api/issues/{id}", issueH.PatchIssue)
	mux.HandleFunc("DELETE /api/issues/{id}", issueH.DeleteIssue)
```

- [ ] **Step 3: Verify it builds and runs**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output, exit 0.

Then start the backend and do a manual end-to-end smoke test:

```bash
cd backend && go run ./cmd/server &
sleep 1
curl -s -X POST localhost:8989/api/seed | head -c 200
WS_ID=$(curl -s localhost:8989/api/workspaces | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
PROJ_ID=$(curl -s localhost:8989/api/workspaces | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['projects'][0]['id'])")
curl -s -X POST localhost:8989/api/projects/$PROJ_ID/issues -d '{"title":"Fix login bug"}'
echo
kill %1
```

Expected: the `POST .../issues` call returns a JSON `Issue` object with `"status":"todo"`, `"priority":"normal"`, `"position":0`, a generated `is-`-prefixed `id`, and `"assignee":null`.

- [ ] **Step 4: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat: register issue routes"
```

---

### Task 5: Frontend domain types

**Files:**
- Modify: `frontend/src/store/types.ts`

**Interfaces:**
- Produces: `IssueStatus` type, `Issue` interface, `Project.issues: Issue[]`. Consumed by every later frontend task.

- [ ] **Step 1: Add the types**

In `frontend/src/store/types.ts`, add this after the `Priority`/`InvoiceStatus` type aliases (after line 5):

```ts
export type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'
```

Add the `Issue` interface after the `Project` interface (after line 46, its closing `}`):

```ts
export interface Issue {
  id: string
  title: string
  description: string
  status: IssueStatus
  priority: Priority
  assignee: string | null
  position: number
  createdAt: string
  updatedAt: string
}
```

Then add an `issues` field to `Project` so it reads:

```ts
export interface Project {
  id: string
  name: string
  repo: string
  path: string
  expanded: boolean
  worktrees: Worktree[]
  issues: Issue[]
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0. `Project` data only ever comes from the backend via `fetchWorkspaces()` (`frontend/src/lib/api.ts`) — there are no local object literals constructing a `Project` (confirmed: `grep -rn "worktrees:" frontend/src` matches only the type declaration itself), so adding a new required field to the interface has nothing else to update.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/store/types.ts
git commit -m "feat: add Issue domain types to frontend"
```

---

### Task 6: API client functions

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: `Issue`, `IssueStatus`, `Priority` (Task 5).
- Produces: `CreateIssueBody`, `UpdateIssueBody` types; `createIssue(projectId, body)`, `updateIssue(id, patch)`, `deleteIssue(id)` functions. Consumed by Task 7.

- [ ] **Step 1: Add `Issue` to the type import**

In `frontend/src/lib/api.ts`, add `Issue` to the `import type { ... } from '@/store/types'` block (alphabetically, after `Invoice, InvoiceItem, InvoiceStatus,`):

```ts
import type {
  Agent,
  AgentModel,
  AgentSkill,
  AgentSummary,
  Bank,
  Company,
  FsEntry,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  Issue,
  NewsItem,
  Priority,
  Project,
  Settings,
  TermLine,
  Todo,
  Workspace,
  Worktree,
} from '@/store/types'
```

- [ ] **Step 2: Add the payload shape interfaces**

Add after `UpdateNewsBody` (after line 193):

```ts
export interface CreateIssueBody {
  title: string
  status?: Issue['status']
}

export interface UpdateIssueBody {
  title?: string
  description?: string
  status?: Issue['status']
  priority?: Priority
  position?: number
  assignee?: string | null
}
```

- [ ] **Step 3: Add the request functions**

Add a new section after `// ---- News ----` block (after `deleteNews`, before `// ---- Seed ----`):

```ts
// ---- Issues ----

export function createIssue(projectId: string, body: CreateIssueBody): Promise<Issue> {
  return request<Issue>('POST', `/projects/${projectId}/issues`, body)
}

export function updateIssue(id: string, patch: UpdateIssueBody): Promise<Issue> {
  return request<Issue>('PATCH', `/issues/${id}`, patch)
}

export function deleteIssue(id: string): Promise<void> {
  return request<void>('DELETE', `/issues/${id}`)
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add issue API client functions"
```

---

### Task 7: React Query hooks

**Files:**
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: `createIssue`, `updateIssue`, `deleteIssue`, `CreateIssueBody`, `UpdateIssueBody` (Task 6).
- Produces: `useCreateIssue()`, `useUpdateIssue()`, `useDeleteIssue()` hooks. Consumed by Tasks 10, 11, 12.

- [ ] **Step 1: Add imports**

In `frontend/src/features/data/queries.ts`, add `createIssue, deleteIssue, updateIssue,` to the `import { ... } from '@/lib/api'` block (alphabetically — `createIssue` after `createInvoice`, `deleteIssue` after `deleteInvoice`, `updateIssue` after `updateInvoice`), and add `CreateIssueBody, UpdateIssueBody,` to the `import type { ... } from '@/lib/api'` block (alphabetically after `CreateInvoiceBody,` / `UpdateInvoiceBody,` respectively).

- [ ] **Step 2: Add the mutation hooks**

Add this after `useDeleteInvoice` (after line 237, its closing `}`):

```ts
export function useCreateIssue() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: CreateIssueBody }) => createIssue(projectId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateIssue() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateIssueBody }) => updateIssue(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteIssue() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteIssue(id),
    onSuccess: () => invalidate(),
  })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/data/queries.ts
git commit -m "feat: add issue React Query mutation hooks"
```

---

### Task 8: Install kanban/markdown dependencies + status styling constant

**Files:**
- Modify: `frontend/package.json` (via `npm install`)
- Modify: `frontend/src/lib/constants.ts`

**Interfaces:**
- Produces: `ISSUE_STATUS: Record<IssueStatus, { label: string; color: string }>` constant. Consumed by Tasks 10, 11, 12.

- [ ] **Step 1: Install the new dependencies**

Run: `cd frontend && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities react-markdown remark-gfm`
Expected: exits 0, `frontend/package.json` and `frontend/package-lock.json` (or equivalent lockfile) gain these five entries.

- [ ] **Step 2: Add `IssueStatus` to the constants type import**

In `frontend/src/lib/constants.ts`, change the top import to:

```ts
import type { InvoiceStatus, IssueStatus, LineKind, Priority, WorktreeState } from '@/store/types'
```

- [ ] **Step 3: Add the `ISSUE_STATUS` constant**

Add after the `PRI` constant (after line 16, its closing `}`):

```ts
export const ISSUE_STATUS: Record<IssueStatus, { label: string; color: string }> = {
  todo: { label: 'Todo', color: '#6b7280' },
  in_progress: { label: 'In Progress', color: '#6d8bff' },
  in_review: { label: 'In Review', color: '#f5c451' },
  done: { label: 'Done', color: '#56d58a' },
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/constants.ts
git commit -m "feat: add dnd-kit + react-markdown deps and issue status styling"
```

---

### Task 9: Markdown rendering components

**Files:**
- Create: `frontend/src/features/issues/MarkdownPreview.tsx`
- Create: `frontend/src/features/issues/MarkdownEditor.tsx`
- Modify: `frontend/src/styles/globals.css`

**Interfaces:**
- Produces: `<MarkdownPreview source={string} />`, `<MarkdownEditor value={string} onChange={(v: string) => void} onBlur={() => void} placeholder={string} />`. Consumed by Task 12 (`IssueDetail`).

- [ ] **Step 1: Add markdown typography styles**

In `frontend/src/styles/globals.css`, add this block at the end of the file (after the existing `@layer base { ... }` block's closing `}`):

```css
.loom-markdown h1,
.loom-markdown h2,
.loom-markdown h3 {
  font-weight: 600;
  color: var(--loom-fg);
  line-height: 1.3;
}
.loom-markdown h1 {
  font-size: 18px;
}
.loom-markdown h2 {
  font-size: 15.5px;
}
.loom-markdown h3 {
  font-size: 13.5px;
}
.loom-markdown p {
  margin: 0;
}
.loom-markdown ul,
.loom-markdown ol {
  padding-left: 1.25em;
  display: flex;
  flex-direction: column;
  gap: 0.25em;
}
.loom-markdown a {
  color: var(--loom-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.loom-markdown code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--loom-popover);
  border: 1px solid var(--loom-border-strong);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.loom-markdown pre {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--loom-popover);
  border: 1px solid var(--loom-border-strong);
  border-radius: 8px;
  padding: 0.75em 1em;
  overflow-x: auto;
}
.loom-markdown pre code {
  background: none;
  border: none;
  padding: 0;
}
.loom-markdown table {
  border-collapse: collapse;
  font-size: 0.9em;
}
.loom-markdown th,
.loom-markdown td {
  border: 1px solid var(--loom-border-strong);
  padding: 0.35em 0.6em;
}
.loom-markdown blockquote {
  border-left: 2px solid var(--loom-border-accent);
  padding-left: 0.75em;
  color: var(--loom-dim);
  margin: 0;
}
```

- [ ] **Step 2: Create `MarkdownPreview`**

Create `frontend/src/features/issues/MarkdownPreview.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Read-only markdown rendering with Loom's typography tokens. */
export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="font-mono text-[12px] text-loom-dim">Nothing to preview.</p>
  }
  return (
    <div className="loom-markdown flex flex-col gap-2.5 text-[13px] leading-relaxed text-loom-fg-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}
```

- [ ] **Step 3: Create `MarkdownEditor`**

Create `frontend/src/features/issues/MarkdownEditor.tsx`:

```tsx
import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { MarkdownPreview } from './MarkdownPreview'

type Tab = 'write' | 'preview'

const TABS: Tab[] = ['write', 'preview']

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
}) {
  const [tab, setTab] = useState<Tab>('write')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 self-start rounded-lg border border-loom-border-strong p-0.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'h-6 cursor-pointer rounded-md px-2.5 font-mono text-[11px] capitalize transition-colors',
              tab === t ? 'bg-loom-popover text-loom-fg' : 'text-loom-dim hover:text-loom-fg-2',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'write' ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={10}
        />
      ) : (
        <div className="rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2.5">
          <MarkdownPreview source={value} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/issues/MarkdownPreview.tsx frontend/src/features/issues/MarkdownEditor.tsx frontend/src/styles/globals.css
git commit -m "feat: add markdown preview/editor components for issue descriptions"
```

---

### Task 10: Kanban card + column components

**Files:**
- Create: `frontend/src/features/issues/IssueCard.tsx`
- Create: `frontend/src/features/issues/IssueColumn.tsx`

**Interfaces:**
- Consumes: `Issue`, `IssueStatus` (Task 5), `ISSUE_STATUS`, `PRI` (Task 8), `useCreateIssue` (Task 7, used by the parent board, not here).
- Produces: `<IssueCard issue={Issue} wsId={string} projectId={string} />`, `<IssueCardOverlay issue={Issue} />` (static visual clone for `DragOverlay`, no sortable hook of its own), `<IssueColumn status={IssueStatus} issues={Issue[]} wsId={string} projectId={string} onAdd={(title: string) => void} />`. Consumed by Task 11 (`IssuesBoard`).

- [ ] **Step 1: Create `IssueCard`**

Create `frontend/src/features/issues/IssueCard.tsx`. `DragOverlay` (used in Task 11) needs a visual clone of the card that renders while dragging — it must NOT call `useSortable` itself (that would register a second sortable instance for the same id), so the shared markup is split into a hook-free `CardBody` and two thin wrappers:

```tsx
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNavigate } from '@tanstack/react-router'
import { Pill } from '@/components/ui/pill'
import { PRI } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Issue } from '@/store/types'

const cardClass =
  'flex cursor-pointer flex-col gap-1.5 rounded-[11px] border border-loom-border-card bg-loom-card px-2.5 py-2 text-left hover:border-loom-border-accent'

function CardBody({ issue }: { issue: Issue }) {
  const pri = PRI[issue.priority]
  return (
    <>
      <span className="line-clamp-2 text-[12.5px] leading-snug text-loom-fg">{issue.title}</span>
      <div className="flex items-center gap-1.5">
        <Pill color={pri.color}>{pri.label}</Pill>
        {issue.assignee ? (
          <span className="truncate font-mono text-[10.5px] text-loom-dim">{issue.assignee}</span>
        ) : null}
      </div>
    </>
  )
}

export function IssueCard({ issue, wsId, projectId }: { issue: Issue; wsId: string; projectId: string }) {
  const navigate = useNavigate()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() =>
        navigate({
          to: '/w/$wsId/p/$projectId/issues/$issueId',
          params: { wsId, projectId, issueId: issue.id },
        })
      }
      className={cn(cardClass, isDragging && 'opacity-40')}
    >
      <CardBody issue={issue} />
    </div>
  )
}

/** Static visual clone rendered inside DragOverlay — deliberately has no drag listeners of its own. */
export function IssueCardOverlay({ issue }: { issue: Issue }) {
  return (
    <div className={cardClass}>
      <CardBody issue={issue} />
    </div>
  )
}
```

- [ ] **Step 2: Create `IssueColumn`**

Create `frontend/src/features/issues/IssueColumn.tsx`:

```tsx
import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ISSUE_STATUS } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Issue, IssueStatus } from '@/store/types'
import { IssueCard } from './IssueCard'

export function IssueColumn({
  status,
  issues,
  wsId,
  projectId,
  onAdd,
}: {
  status: IssueStatus
  issues: Issue[]
  wsId: string
  projectId: string
  onAdd: (title: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const cfg = ISSUE_STATUS[status]

  function submit() {
    const t = title.trim()
    if (t) onAdd(t)
    setTitle('')
    setAdding(false)
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 flex-none flex-col rounded-[14px] border border-loom-border-card bg-loom-bg/40 p-2',
        isOver && 'border-loom-border-accent',
      )}
    >
      <div className="flex items-center gap-2 px-1.5 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: cfg.color }} />
        <span className="font-mono text-[11.5px] font-semibold text-loom-fg-2">{cfg.label}</span>
        <span className="font-mono text-[11px] text-loom-dim">{issues.length}</span>
        <div className="min-w-2 flex-1" />
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Add issue"
          className="cursor-pointer rounded-md p-1 text-loom-muted-2 hover:text-loom-fg-2"
        >
          <Plus size={14} />
        </button>
      </div>

      {adding ? (
        <div className="px-1.5 pb-1.5">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setTitle('')
                setAdding(false)
              }
            }}
            onBlur={submit}
            placeholder="Issue title…"
          />
        </div>
      ) : null}

      <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5 overflow-y-auto px-0.5 pb-1">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} wsId={wsId} projectId={projectId} />
          ))}
          {issues.length === 0 && !adding ? (
            <div className="py-6 text-center font-mono text-[11px] text-loom-dim">no issues</div>
          ) : null}
        </div>
      </SortableContext>
    </div>
  )
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/issues/IssueCard.tsx frontend/src/features/issues/IssueColumn.tsx
git commit -m "feat: add kanban issue card and column components"
```

---

### Task 11: Kanban board + board route

**Files:**
- Create: `frontend/src/features/issues/IssuesBoard.tsx`
- Create: `frontend/src/routes/w.$wsId.p.$projectId.issues.tsx`
- Create: `frontend/src/routes/w.$wsId.p.$projectId.issues.index.tsx`

**Interfaces:**
- Consumes: `IssueColumn`, `IssueCardOverlay` (Task 10), `useCreateIssue`, `useUpdateIssue` (Task 7), `useWorkspace` (existing, `frontend/src/features/data/queries.ts`).
- Produces: `<IssuesBoard project={Project} wsId={string} />`, routes `/w/$wsId/p/$projectId/issues` (layout) and its index (board). Consumed by Task 12 (`issues.$issueId.tsx` nests under the `issues.tsx` layout created here) and Task 13 (navigation tabs link to `/w/$wsId/p/$projectId/issues`).

Note on route nesting: this project's file-based routes use the flat dot-convention (e.g. `w.$wsId.p.$projectId.wt.$wtId.tsx`). Because Task 12 adds `w.$wsId.p.$projectId.issues.$issueId.tsx` — sharing the `issues` path prefix with this task's route file — `w.$wsId.p.$projectId.issues.tsx` becomes a genuine parent layout in the router tree and **must** render `<Outlet/>`, exactly like `w.$wsId.p.$projectId.tsx` (the project layout) does for its own children. The actual board UI therefore lives in a sibling `.index.tsx` file, mirroring the existing `w.$wsId.p.$projectId.tsx` (layout) + `w.$wsId.p.$projectId.index.tsx` (leaf) pair.

- [ ] **Step 1: Create `IssuesBoard`**

Create `frontend/src/features/issues/IssuesBoard.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { Issue, IssueStatus, Project } from '@/store/types'
import { useCreateIssue, useUpdateIssue } from '@/features/data/queries'
import { IssueCardOverlay } from './IssueCard'
import { IssueColumn } from './IssueColumn'

const STATUSES: IssueStatus[] = ['todo', 'in_progress', 'in_review', 'done']

export function IssuesBoard({ project, wsId }: { project: Project; wsId: string }) {
  const createIssue = useCreateIssue()
  const updateIssue = useUpdateIssue()
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const byStatus = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = { todo: [], in_progress: [], in_review: [], done: [] }
    for (const issue of project.issues) map[issue.status].push(issue)
    for (const status of STATUSES) map[status].sort((a, b) => a.position - b.position)
    return map
  }, [project.issues])

  function handleDragStart(event: DragStartEvent) {
    setActiveIssue(project.issues.find((i) => i.id === event.active.id) ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveIssue(null)
    const { active, over } = event
    if (!over) return

    const dragged = project.issues.find((i) => i.id === active.id)
    if (!dragged) return

    const overStatus = (STATUSES as string[]).includes(over.id as string)
      ? (over.id as IssueStatus)
      : project.issues.find((i) => i.id === over.id)?.status
    if (!overStatus) return

    const column = byStatus[overStatus].filter((i) => i.id !== dragged.id)
    const overIndex = column.findIndex((i) => i.id === over.id)
    const insertAt = overIndex === -1 ? column.length : overIndex

    const prev = column[insertAt - 1]
    const next = column[insertAt]
    const position = !prev && !next ? 0 : !prev ? next.position - 1 : !next ? prev.position + 1 : (prev.position + next.position) / 2

    if (overStatus === dragged.status && position === dragged.position) return

    updateIssue.mutate({ id: dragged.id, patch: { status: overStatus, position } })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {STATUSES.map((status) => (
          <IssueColumn
            key={status}
            status={status}
            issues={byStatus[status]}
            wsId={wsId}
            projectId={project.id}
            onAdd={(title) => createIssue.mutate({ projectId: project.id, body: { title, status } })}
          />
        ))}
      </div>
      <DragOverlay>{activeIssue ? <IssueCardOverlay issue={activeIssue} /> : null}</DragOverlay>
    </DndContext>
  )
}
```

- [ ] **Step 2: Create the issues layout route**

Create `frontend/src/routes/w.$wsId.p.$projectId.issues.tsx` — a pathless-in-effect layout that only renders `<Outlet/>` (the breadcrumb and Worktrees/Issues tabs already come from the parent `ProjectLayout`, so this file adds no UI of its own):

```tsx
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues')({
  component: () => <Outlet />,
})
```

- [ ] **Step 3: Create the board (index) route**

Create `frontend/src/routes/w.$wsId.p.$projectId.issues.index.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { IssuesBoard } from '@/features/issues/IssuesBoard'
import { useWorkspace } from '@/features/data/queries'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues/')({
  component: IssuesRoute,
})

function IssuesRoute() {
  const { wsId, projectId } = Route.useParams()
  const project = useWorkspace(wsId).data?.projects.find((p) => p.id === projectId)
  if (!project) return null
  return <IssuesBoard project={project} wsId={wsId} />
}
```

- [ ] **Step 4: Regenerate the route tree and verify it compiles**

Run: `cd frontend && npx @tanstack/router-plugin --target react && npm run typecheck`
Expected: `src/routeTree.gen.ts` gains `/w/$wsId/p/$projectId/issues` (layout) and `/w/$wsId/p/$projectId/issues/` (index) entries; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/issues/IssuesBoard.tsx frontend/src/routes/w.\$wsId.p.\$projectId.issues.tsx frontend/src/routes/w.\$wsId.p.\$projectId.issues.index.tsx frontend/src/routeTree.gen.ts
git commit -m "feat: add kanban issues board and route"
```

---

### Task 12: Issue detail page + detail route

**Files:**
- Create: `frontend/src/features/issues/IssueDetail.tsx`
- Create: `frontend/src/routes/w.$wsId.p.$projectId.issues.$issueId.tsx`

**Interfaces:**
- Consumes: `MarkdownEditor` (Task 9), `useUpdateIssue`, `useDeleteIssue` (Task 7), `ISSUE_STATUS`, `PRI` (Task 8), `EmptyState` (existing, `frontend/src/features/screens/EmptyState.tsx`), the `w.$wsId.p.$projectId.issues.tsx` layout (Task 11) that this route file nests under (path `/w/$wsId/p/$projectId/issues/$issueId`).

- [ ] **Step 1: Create `IssueDetail`**

Create `frontend/src/features/issues/IssueDetail.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ISSUE_STATUS, PRI } from '@/lib/constants'
import type { Issue, IssueStatus, Priority } from '@/store/types'
import { useDeleteIssue, useUpdateIssue } from '@/features/data/queries'
import { MarkdownEditor } from './MarkdownEditor'

const STATUS_OPTIONS = (Object.keys(ISSUE_STATUS) as IssueStatus[]).map((s) => ({
  value: s,
  label: ISSUE_STATUS[s].label,
}))

const PRI_OPTIONS = (Object.keys(PRI) as Priority[]).map((p) => ({ value: p, label: PRI[p].label }))

export function IssueDetail({ issue, wsId, projectId }: { issue: Issue; wsId: string; projectId: string }) {
  const navigate = useNavigate()
  const updateIssue = useUpdateIssue()
  const deleteIssue = useDeleteIssue()

  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description)
  const [assignee, setAssignee] = useState(issue.assignee ?? '')

  useEffect(() => {
    setTitle(issue.title)
    setDescription(issue.description)
    setAssignee(issue.assignee ?? '')
  }, [issue.id, issue.title, issue.description, issue.assignee])

  function saveTitle() {
    const t = title.trim()
    if (t && t !== issue.title) updateIssue.mutate({ id: issue.id, patch: { title: t } })
  }

  function saveDescription() {
    if (description !== issue.description) updateIssue.mutate({ id: issue.id, patch: { description } })
  }

  function saveAssignee() {
    const a = assignee.trim()
    if (a !== (issue.assignee ?? '')) updateIssue.mutate({ id: issue.id, patch: { assignee: a || null } })
  }

  function handleDelete() {
    deleteIssue.mutate(issue.id, {
      onSuccess: () => navigate({ to: '/w/$wsId/p/$projectId/issues', params: { wsId, projectId } }),
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          className="flex-1 border-none bg-transparent px-0 text-[17px] font-semibold text-loom-fg focus-visible:ring-0"
        />
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteIssue.isPending}>
          <Trash2 size={13} />
          Delete
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[150px]">
          <Select
            value={issue.status}
            onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { status: v as IssueStatus } })}
            options={STATUS_OPTIONS}
            aria-label="Status"
          />
        </div>
        <div className="w-[118px]">
          <Select
            value={issue.priority}
            onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { priority: v as Priority } })}
            options={PRI_OPTIONS}
            aria-label="Priority"
          />
        </div>
        <div className="w-[180px]">
          <Input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={saveAssignee}
            placeholder="Unassigned"
          />
        </div>
      </div>

      <MarkdownEditor
        value={description}
        onChange={setDescription}
        onBlur={saveDescription}
        placeholder="Describe the issue…"
      />
    </div>
  )
}
```

- [ ] **Step 2: Create the detail route**

Create `frontend/src/routes/w.$wsId.p.$projectId.issues.$issueId.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { IssueDetail } from '@/features/issues/IssueDetail'
import { useWorkspace } from '@/features/data/queries'
import { EmptyState } from '@/features/screens/EmptyState'

export const Route = createFileRoute('/w/$wsId/p/$projectId/issues/$issueId')({
  component: IssueDetailRoute,
})

function IssueDetailRoute() {
  const { wsId, projectId, issueId } = Route.useParams()
  const project = useWorkspace(wsId).data?.projects.find((p) => p.id === projectId)
  const issue = project?.issues.find((i) => i.id === issueId)
  if (!issue) return <EmptyState title="Issue not found" hint="It may have been deleted." />
  return <IssueDetail issue={issue} wsId={wsId} projectId={projectId} />
}
```

- [ ] **Step 3: Regenerate the route tree and verify it compiles**

Run: `cd frontend && npx @tanstack/router-plugin --target react && npm run typecheck`
Expected: `src/routeTree.gen.ts` gains a `/w/$wsId/p/$projectId/issues/$issueId` entry; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/issues/IssueDetail.tsx frontend/src/routes/w.\$wsId.p.\$projectId.issues.\$issueId.tsx frontend/src/routeTree.gen.ts
git commit -m "feat: add issue detail page and route"
```

---

### Task 13: Project-level tab navigation (Worktrees / Issues)

**Files:**
- Modify: `frontend/src/routes/w.$wsId.p.$projectId.tsx`

**Interfaces:**
- Consumes: routes from Task 11 (`/w/$wsId/p/$projectId/issues`) and the existing `/w/$wsId/p/$projectId` (worktree cards grid) route.

- [ ] **Step 1: Add the tab switcher**

Replace the full contents of `frontend/src/routes/w.$wsId.p.$projectId.tsx` with:

```tsx
import { Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router'
import { fetchWorkspaces } from '@/lib/api'
import { qk } from '@/features/data/keys'
import { AgentsBreadcrumb } from '@/features/agents/AgentsBreadcrumb'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/w/$wsId/p/$projectId')({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient
    let workspaces
    try {
      workspaces = await qc.ensureQueryData({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
    } catch {
      return // backend down — parent layout renders the error state
    }
    const ws = workspaces.find((w) => w.id === params.wsId)
    if (ws && !ws.projects.some((p) => p.id === params.projectId)) {
      throw redirect({ to: '/w/$wsId', params: { wsId: params.wsId } })
    }
  },
  component: ProjectLayout,
})

const TABS = [
  { to: '/w/$wsId/p/$projectId', label: 'Worktrees', match: (path: string) => !path.includes('/issues') },
  { to: '/w/$wsId/p/$projectId/issues', label: 'Issues', match: (path: string) => path.includes('/issues') },
] as const

function ProjectLayout() {
  const { wsId, projectId } = Route.useParams()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  const inWorktree = pathname.includes('/wt/')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentsBreadcrumb />
      {inWorktree ? null : (
        <div className="flex flex-none items-center gap-1 border-b border-loom-border px-4 py-1.5">
          {TABS.map((tab) => (
            <button
              key={tab.to}
              type="button"
              onClick={() => navigate({ to: tab.to, params: { wsId, projectId } })}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1 font-mono text-[11.5px] transition-colors',
                tab.match(pathname) ? 'bg-loom-popover text-loom-fg' : 'text-loom-dim hover:text-loom-fg-2',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <Outlet />
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors, exits 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/w.\$wsId.p.\$projectId.tsx
git commit -m "feat: add Worktrees/Issues tab switcher to project layout"
```

---

### Task 14: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Backend — build, vet, test**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all pass, no output from `build`/`vet`, `test` prints `ok` for every package.

- [ ] **Step 2: Frontend — typecheck and production build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both exit 0 with no type errors and a successful Vite build.

- [ ] **Step 3: Manual smoke test**

Run: `cd frontend && npm run dev` (starts both frontend `:5173` and backend `:8989`).

In the browser:
1. Open a workspace, open a project. Confirm a "Worktrees | Issues" tab row now appears below the breadcrumb.
2. Click "Issues" — confirm four columns render (Todo / In Progress / In Review / Done), all empty.
3. Click "+" on the Todo column, type a title, press Enter — confirm a card appears in Todo.
4. Drag the card into "In Progress" — confirm it moves and persists after a page refresh.
5. Click the card — confirm the detail page opens at `/w/<wsId>/p/<projectId>/issues/<issueId>`.
6. Edit the title (blur to save), write a description with a heading, a list, and a code block in the "Write" tab, switch to "Preview" — confirm it renders as formatted markdown (not raw `#`/`-`/backticks).
7. Change status and priority via the dropdowns, set an assignee — confirm each persists after refresh.
8. Click "Delete" — confirm it navigates back to the board and the card is gone.
9. Navigate to `/w/<wsId>/p/<projectId>/issues/does-not-exist` — confirm the "Issue not found" empty state renders instead of a crash.

- [ ] **Step 4: Fix anything the smoke test surfaces, then final commit**

If any step in the manual smoke test fails, fix the specific file involved (not a broad rewrite) and re-run the affected steps above before considering the feature done. Once everything passes, no further commit is needed beyond the per-task commits already made.
