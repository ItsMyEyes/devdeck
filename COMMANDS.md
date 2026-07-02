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
cd backend && go run ./cmd/server
```

The Go backend accepts flags:
- `--addr` — listen address (default `:8989`, env `LOOM_ADDR`)
- `--db` — SQLite path (default `backend/loom.db`, env `LOOM_DB`)
- `--jadi` — remote agent registry URL (env `LOOM_JADI_URL`, empty = static built-in)

## Build

```bash
# Frontend production build
cd frontend && npm run build

# Backend binary
cd frontend && npm run build:api
# or directly:
cd backend && go build -o loom-api ./cmd/server
```

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
