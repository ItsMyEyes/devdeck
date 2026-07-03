# Commands

> Referenced from CLAUDE.md. Default shell: zsh.

All commands run from the monorepo root unless noted.

## Development

```bash
# Start both frontend (Vite :5173) and backend (Go :8989)
cd frontend && npm run dev

# Frontend only
cd frontend && npm run dev:web

# Backend only
cd frontend && npm run dev:api
# or directly:
cd backend && go run ./cmd/server --db loom.db --open=false
```

The Go backend accepts flags:
- `--addr` — listen address (default `127.0.0.1:8989`, env `LOOM_ADDR`)
- `--db` — SQLite path (default `data/loom.db` beside the executable, env `LOOM_DB`)
- `--jadi` — remote agent registry URL (env `LOOM_JADI_URL`, empty = static built-in)
- `--open` — open the embedded UI in the default browser (default true)
- `LOOM_AUTH_KEY` — base64-encoded 32-byte AES key used to encrypt TOTP
  secrets at rest (env only, no flag). If unset, a key is generated once and
  stored as `auth.key` beside the database.

## MCP server (agent-facing issue tracker)

`backend/cmd/mcp-server` exposes Loom's issues as MCP tools over stdio, so a
coding agent (e.g. one running inside a Loom-managed worktree) can file its
own tickets: `list_projects`, `create_issue` (assignee is required — the
calling agent should ask if it isn't obvious), `upload_attachment` (attaches
a local file and, by default, appends its link to the issue description),
and `mark_issue_done` (moves an issue to `in_review`). It opens the **same**
`--db` file as the main server (WAL mode makes that safe) — point it at
`loom.db` beside your running instance, not a separate database.

```bash
cd backend && go run ./cmd/mcp-server --db loom.db
# or: make build-mcp   (writes backend/loom-mcp-server)
```

Point an MCP client at it, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "loom-issues": {
      "command": "/path/to/loom-mcp-server",
      "args": ["--db", "/path/to/loom.db"]
    }
  }
}
```

## Build

```bash
# Host binary with the production UI embedded
make build

# Portable binary for the current OS and architecture
make portable

# macOS, Linux, and Windows release matrix (amd64 + arm64)
make portable-all
```

`make build` writes `backend/loom-api`. Portable builds are written to `dist/`.
The executable creates `data/loom.db` beside itself on first launch. Node.js and
Go are build-time dependencies only; end users still need Git and their selected
coding-agent CLI installed.

## Type checking / linting

```bash
# TypeScript
cd frontend && npm run typecheck

# Go
cd backend && go vet ./...
```

## Testing

No test suite yet. When added:
- Frontend: Vitest (anticipated — Vite-native)
- Backend: `go test ./...` (stdlib testing)

## Code generation

TanStack Router codegens `frontend/src/routeTree.gen.ts` automatically on file save
(via the Vite plugin). If it's stale:

```bash
cd frontend && npx @tanstack/router-plugin --target react
```

## Conventions

- Run `npm run typecheck` and `go vet ./...` before committing.
- Run `npm run build` before pushing to verify no build regressions.
- The frontend dev server proxies `/api` and `/ws/terminal` to the Go backend
  (configured in `vite.config.ts`). Ensure the backend is running on the expected port.
- Node.js terminal gateway (`frontend/server/terminal-server.mjs`) is legacy;
  the canonical terminal server is the Go `internal/terminal` package.
