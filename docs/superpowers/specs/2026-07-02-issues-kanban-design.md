# Issues: per-project kanban board, issue detail, markdown description

## Context

Studied `multica-ai/multica` (open-source managed-agents platform) for its
Issues module — `packages/views/issues/*` + `packages/views/editor/*`. Key
takeaways adapted here (not copied wholesale — different stack, smaller
scope):

- Issue is a flat record: title, markdown `description`, `status` (string
  union), `priority` (string union), assignee, a sortable `position` for
  manual ordering within a column.
- Kanban board = one column per status, drag-and-drop via `@dnd-kit`,
  cross-column drag patches `status` (+ recomputes `position`); same-column
  drag only recomputes `position`.
- Issue detail is a routed page (not a modal), with an editable title,
  description, and a properties block (status/priority/assignee/dates).
- Storage is **plain markdown text**, never rich-editor JSON. Multica edits
  it through a Tiptap WYSIWYG that round-trips to markdown, but renders it
  read-only through `react-markdown` + `remark-gfm` (no live editor
  overhead for read-only views).

This spec scopes a smaller version of the same shape into Loom, since Loom
has no Issue concept today (unlike News/Todos/Invoices, which already have
their data model and API wired — Issues is being built from scratch, all the
way from domain types down).

The user did not respond to the two scoping questions asked before this doc
was written (project- vs workspace-scoped; markdown-preview vs full
WYSIWYG). The recommended option was taken in both cases and is flagged
below — revise this doc if either call was wrong.

## Scope

**Per-Project** (recommended, taken by default): each `Project` (a git repo)
gets its own kanban board, the same way it already gets its own list of
`Worktree`s. This matches multica's model (issues belong to a project) and
Loom's existing repo-centric `Project` entity. A workspace-wide view is not
in scope.

**Markdown**: description is edited as plain markdown text in a textarea
with a Write/Preview toggle (recommended, taken by default) — not a
WYSIWYG rich editor. This matches the literal ask ("markdown render") and
avoids pulling in Tiptap/ProseMirror, which is a large dependency for a
feature that doesn't need live-editing affordances yet.

**Out of scope for this pass** (can be follow-ups, not blocking):

- Comments / activity timeline on an issue.
- Assigning an issue to an agent (spawning a worktree from an issue).
  `assignee` is a plain optional text field for now, same shape as a label.
- Sub-issues / parent-child relationships.
- Reactions, labels, attachments.

## Data model

New type, added to both `frontend/src/store/types.ts` and
`backend/internal/domain/models.go` (per `CONTRACTS.md`):

```ts
export type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

export interface Issue {
  id: string
  title: string
  description: string // markdown source; '' when empty
  status: IssueStatus
  priority: Priority // reuse existing high|normal|low — no new priority enum
  assignee: string | null
  position: number // fractional sort key, unique within (projectId, status)
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}
```

`Project` gains a nested list, mirroring how it already nests `worktrees`:

```ts
export interface Project {
  // ...existing fields
  issues: Issue[]
}
```

```go
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

type Project struct {
    // ...existing fields
    Issues []Issue `json:"issues"`
}
```

Status/priority stay plain strings on the Go side (matches the existing
`Todo.Priority string` / `Invoice.Status string` convention — no Go enum
wrapper). ID prefix: `is-` (generated via `crypto/rand`, matching
`ws-`/`p-`/`w-`/`t-`/`iv-`).

### Ordering (`position`)

The client holds the full board in memory already (it comes down as part of
the workspace fetch), so **the client computes the new `position`** on drop
— midpoint between the two neighboring cards' known positions in the target
column (or `neighbor ± 1` at an edge, or `0` for an empty column) — and
sends `{status, position}` in the PATCH body. The backend just persists
whatever it's given; no server-side neighbor lookups, no resequencing pass.
This is the same fractional-key approach multica uses, minus their
Postgres-collation caveat (SQLite doesn't have an equivalent complication
here since we're not relying on DB-side collation for ordering).

## Backend (canonical order, per `ARCHITECTURE.md`)

1. `domain/models.go` — `Issue` struct, `Project.Issues` field.
2. `port/store.go` — add to `Store` interface:
   - `CreateIssue(projectID, title string) (domain.Issue, error)` — status
     defaults to `todo`, priority to `normal`, position to
     `max(existing positions in todo column) + 1` (or `0`).
   - `UpdateIssue(id string, patch IssuePatch) (domain.Issue, error)` —
     `IssuePatch` has pointer fields for `Title`, `Description`, `Status`,
     `Priority`, `Position`, plus `Assignee *string` / `HasAssignee bool`
     (nullable field, per `CONTRACTS.md`'s `Has*` convention). One patch
     endpoint handles both a normal field edit and a kanban drag-move —
     no separate "move" verb.
   - `DeleteIssue(id string) error`.
3. `store/issue.go` — SQLite implementation. New `issues` table: `id TEXT
   PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title
   TEXT, description TEXT, status TEXT, priority TEXT, assignee TEXT,
   position REAL, created_at TEXT, updated_at TEXT`. Loaded alongside
   worktrees wherever a project is fetched (same join pattern as
   `Worktree`).
4. `service/issue.go` — validates `title` is non-empty on create, validates
   `status`/`priority` are known values on update, sets `updatedAt`.
5. `handler/issue.go` — `POST /api/projects/{projectId}/issues`,
   `PATCH /api/issues/{id}`, `DELETE /api/issues/{id}`. Standard
   `handleStoreErr()` / `decodeBody()` / `writeJSON()` pattern. No separate
   list endpoint — issues ride along inside the existing workspace fetch,
   same as worktrees today.
6. `cmd/server/main.go` — wire `issue.Service`, register the three routes.

## Frontend

New dependencies (flagging for approval since these aren't in
`package.json` yet):

- `@dnd-kit/core` + `@dnd-kit/sortable` — kanban drag-and-drop.
- `react-markdown` + `remark-gfm` — read-only markdown rendering.

Files, under `frontend/src/features/issues/` (one component per file, per
`.claude/rules/frontend.md`):

- `IssuesBoard.tsx` — the board: four columns (`todo` / `in_progress` /
  `in_review` / `done`), wraps `DndContext`, handles `onDragEnd` (computes
  target column + new `position`, fires `useUpdateIssue`).
- `IssueColumn.tsx` — one droppable column, header with count, "+" inline
  add-title input (same interaction as `TodosModule`'s "Add a task" input,
  not a modal).
- `IssueCard.tsx` — sortable card: title, priority pill (reuses `Pill` +
  `PRI` from `lib/constants.ts`, no new priority styling), assignee text if
  set, click navigates to issue detail (drag handle vs. click both live on
  the card, same click-stops-propagation trick multica uses for its inline
  pickers).
- `IssueDetail.tsx` — routed page: editable title (inline, click-to-edit),
  description as a `MarkdownEditor` (Write/Preview tabs over a textarea),
  a small properties row (status `Select`, priority `Select`, assignee
  `Input`), delete button. Loading/error/not-found states per
  `.claude/rules/frontend.md`.
- `MarkdownEditor.tsx` — Write/Preview tab toggle; Preview pane renders
  `MarkdownPreview`.
- `MarkdownPreview.tsx` — thin wrapper: `<ReactMarkdown remarkPlugins={[remarkGfm]}>` with Loom's typography classes applied via a wrapper `div`, reused by both `IssueDetail` and (if ever needed) elsewhere.

Data layer (`frontend/src/features/data/`):

- `keys.ts` — no new query key needed; issues ride inside the existing
  `workspace(wsId)` query, same as worktrees/todos.
- `queries.ts` — `useCreateIssue`, `useUpdateIssue`, `useDeleteIssue`
  mutations, each invalidating the workspace query on success (matches
  `useCreateTodo` etc. exactly).
- `lib/api.ts` — `createIssue`, `updateIssue`, `deleteIssue` client
  functions.

### Navigation

`ProjectLayout` (`routes/w.$wsId.p.$projectId.tsx`) currently renders only a
breadcrumb + `Outlet` — there's no tab switcher because there's only ever
been one project-level view (the worktree cards grid). This adds a second
one, so `ProjectLayout` gets a small two-tab row ("Worktrees" / "Issues"),
shown only when not inside a specific worktree (i.e. hidden once `wtId` is
present in the route, same condition `AgentsBreadcrumb` already uses to
decide whether to show the worktree crumb).

New routes:

- `routes/w.$wsId.p.$projectId.issues.tsx` — board (`IssuesBoard`).
- `routes/w.$wsId.p.$projectId.issues.$issueId.tsx` — detail (`IssueDetail`).

## Error / empty states

- Board: empty project (no issues at all) shows a lightweight empty state
  per column, consistent with `TodosEmpty`/`DataEmpty` patterns already in
  `features/screens/`.
- Detail: unknown `issueId` renders a not-found state and a link back to
  the board (same shape as the existing project-not-found redirect logic
  in `w.$wsId.p.$projectId.tsx`'s `beforeLoad`).

## Testing / verification

- `go vet ./...` after backend changes.
- `npm run typecheck` after frontend changes.
- `npm run build` as the final full check.
- Manual pass: create an issue, drag it across all four columns, edit
  title/description/status/priority/assignee from the detail page, verify
  markdown preview renders (headings, lists, code, links, GFM tables),
  delete an issue, refresh and confirm state persists (SQLite-backed).
