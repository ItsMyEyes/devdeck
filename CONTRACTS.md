# Project Contracts

> Referenced from CLAUDE.md. Mandatory patterns — follow these when writing code.

## API response envelope

Every API response is JSON. Errors use exactly this shape:

```json
{"error": "<message>"}
```

Success responses return the domain object(s) directly (no wrapping envelope):

```json
{"id":"ws-1","name":"Acme Corp","projects":[...]}
```

Do not add fields like `success`, `data`, `code`, or `status` to the envelope.

## Error handling (Go handlers)

Every handler follows this pattern:

```go
func (h *XHandler) DoSomething(w http.ResponseWriter, r *http.Request) {
    // ... parse ...
    result, err := h.svc.DoSomething(...)
    if handleStoreErr(w, err) {
        return
    }
    writeJSON(w, http.StatusOK, result)
}
```

- `handleStoreErr()` maps `store.ErrNotFound` → 404, everything else → 500.
- Never call `writeErr` directly in a handler unless it's a validation error (400).
- Never let a raw SQL/database error reach the client.

## Partial update convention (Go)

Optional update fields use pointers. A `nil` pointer means "not provided" (skip);
a non-nil pointer means "set to this value." Use `Has*` bool fields to distinguish
"key absent" from "key present but null" for nullable fields:

```go
type FooPatch struct {
    Name    *string
    HasName bool  // true when "name" key was in the JSON body (allows explicit null)
}
```

Decode with `decodeBody(r, &patch)` from `handler/middleware.go` — it returns both
a typed struct and a raw key map for presence detection.

## Store interface contract

All data access goes through `port.Store` (defined in `backend/internal/port/store.go`).
- Never call `db.Query()` / `db.Exec()` outside `internal/store/`.
- New store methods follow the existing naming: `CreateX`, `UpdateX`, `DeleteX`.
- Update methods accept a `*Patch` struct; Create methods accept individual args.
- Store methods return `(domain.X, error)`, never `(*domain.X, error)`.
- `Seed()` wipes all data and inserts a fresh demo dataset.

## Domain type mirroring

`frontend/src/store/types.ts` and `backend/internal/domain/models.go` define the
same types. When adding a field:
1. Add it to both files simultaneously.
2. Match the JSON key exactly (`json:"camelCase"` in Go, camelCase property in TS).
3. Match the types: `float64` ↔ `number`, `*string` ↔ `string | null`, `bool` ↔ `boolean`.
4. Go domain types are value types (not pointers), even for nested structs.

## Frontend imports

Use the `@/*` alias for all imports from `src/`:

```ts
import { useLoomStore } from '@/store/useLoomStore'
import { Terminal } from '@/features/terminal/Terminal'
```

Never use relative paths that reach into `src/` (e.g., `../../store/...`).

## verbatimModuleSyntax

TypeScript's `verbatimModuleSyntax` is enabled. Type-only imports must use `import type`:

```ts
import type { Workspace, Worktree } from '@/store/types'
```

Regular `import` for values, `import type` for types. Mixing them in one import won't work.

## File conventions

- TanStack Router auto-generates `src/routeTree.gen.ts` — never hand-edit it.
- Route files use the TanStack file-naming convention: `w.$wsId.p.$projectId.tsx`.
- Feature components live in `src/features/<name>/`; one component per file.
- Backend handlers, services, and store files are one per resource.
- Use `internal/` for all backend packages; nothing outside `cmd/` imports them.
