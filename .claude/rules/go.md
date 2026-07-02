---
paths:
  - "**/*.go"
---
# Go Conventions

## Project-specific rules

- Module path is `loom/backend`. All internal packages are under `loom/backend/internal/`.
- Use Go 1.22+ enhanced `http.ServeMux` with method+path patterns.
- Handlers return void; they write the response directly via `writeJSON()` / `writeErr()`.
- Use `handleStoreErr(w, err)` to map store errors to HTTP responses.
- Use `decodeBody(r, &dst)` to parse JSON request bodies.
- Patch structs use `*T` pointers for optional fields; `nil` means "not provided."
- Use `HasField` bool flags on patch structs to distinguish "key absent" from "key provided as null."
- Domain types in `internal/domain/models.go` are value types (not pointers), even for nested structs.
- IDs are type-prefixed hex: `ws-`, `p-`, `w-`, `n-`, `t-`, `iv-` (generated via `crypto/rand`).
- SQLite is the only database; use `?` placeholders (not `$1`). WAL mode, foreign keys enabled, 5s busy timeout.
- Worktree terminal lines are a JSON TEXT column, capped at 240 lines.
- Use `internal/` for all library packages; wire dependencies manually in `cmd/server/main.go`.
- Logger: use `log.Printf` / `log.Fatalf` (stdlib log).
- Run `go vet ./...` before committing.
