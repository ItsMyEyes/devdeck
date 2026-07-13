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

## Key auth (hub/runtime roles)

- `--role runtime` (key-only auth): every path except `GET /api/health`
  requires the static key. It is presented as `Authorization: Bearer <key>`,
  compared with `crypto/subtle.ConstantTimeCompare`.
- The `?key=` query param is accepted **only** when the request is a
  WebSocket upgrade (`Upgrade: websocket` header present) — the browser
  WebSocket API cannot set headers. A plain (non-upgrade) request with
  `?key=` is rejected with 401; keys must not otherwise travel in URLs.
- `--role hub` (dual auth): the existing session cookie continues to work
  unchanged; `Authorization: Bearer <hubKey>` is accepted as an alternate
  credential when `--key`/`LOOM_KEY` is configured. An empty configured hub
  key never matches any bearer token (cookie-only behavior is preserved).
- `POST /api/auth/key-session` (hub with `--key` only): exchanges
  `Authorization: Bearer <hub key>` for a regular `loom_session` cookie tied
  to the auto-created `operator@loom.desktop` account. Desktop (Tauri)
  bootstrap only — the SPA calls it once at startup when launched with
  `?key=`. Returns the user JSON; 401 on a wrong/absent key.
- `--secure-cookies=false` drops the `Secure` attribute on auth cookies for
  loopback desktop deployments (WebKit webviews reject Secure cookies over
  plain `http://127.0.0.1`). Web deployments keep the default (`true`).

## Machines API (hub role only — runtime registry)

```go
type Machine struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    URL  string `json:"url"`
    // Key is the runtime's static API key. Deliberately serialized: the hub
    // distributes it to authenticated clients for direct-first connections.
    Key string `json:"key"`
}
```

- `GET /api/machines` — lists machines **including keys**; this is the
  key-distribution endpoint for direct-first clients. Reachable only behind
  hub auth.
- `POST /api/machines` — body `{"name","url","key"}`, all required; `url`
  must be an absolute `http(s)` URL (400 otherwise).
- `PATCH /api/machines/{id}` — body is a `port.MachinePatch` (`Name *string`,
  `URL *string`, `Key *string`); `url`, if present, is validated the same way.
- `DELETE /api/machines/{id}` — 204 on success.
- `GET /api/machines/{id}/health` — pings the runtime's public
  `/api/health` with a 3s timeout. Always `200`: `{"status":"online","latencyMs":<int>}`
  or `{"status":"offline"}` — offline is data, not an error. 404 only for an
  unknown machine id. The frontend polls this to drive online/offline badges
  and the direct-vs-proxy switch.
- `/api/machines/{id}/proxy/{rest...}` — method-less fallback reverse proxy
  (REST + WebSocket) to the registered runtime; clients connect direct-first
  over the tailnet and fall back to this route. Contract:
  - Forwards to `machine.URL + "/" + rest` plus the original query string,
    with the `key` query param stripped (the hub key must never reach a
    runtime).
  - Injects `Authorization: Bearer <machine.Key>` server-side; drops the
    inbound `Cookie` and `Authorization` headers (hub credentials must not
    reach runtimes).
  - Strips `Access-Control-Allow-*` headers from the runtime's response — the
    hub's own `CorsMiddleware` sets them; forwarding both duplicates the
    header.
  - Unknown machine id → standard 404 `{"error":...}` envelope. Unreachable
    runtime → `502 {"error":"machine unreachable"}`.

### Runtime self-registration

A `--role runtime` process with `--hub-url`/`--hub-key` set upserts itself
into the hub's registry on startup instead of requiring a manual `POST
/api/machines` — see
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`.
It's implemented entirely client-side (`machineclient.SelfRegister`),
reusing the endpoints above unchanged: `GET /api/machines` to find an
existing entry whose `url` matches this runtime's `--public-url`, then
`PATCH` (if found and `name`/`key` differ) or `POST` (if not found).
Failure is logged and retried every 30s in the background; it never blocks
or fails runtime startup.

## Project.machineId

`domain.Project` has `MachineID string` (`json:"machineId"`), linking a
project to a registered runtime machine. Empty string means
local/unassigned; pre-existing rows default to it via
`migrateProjectColumns`. `CreateProject`/`UpdateProject` thread it through
like `path`/`repo`; the create/update request bodies use the `machineId`
JSON key.

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
