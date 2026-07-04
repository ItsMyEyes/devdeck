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
- `--only-from` — comma-separated IPs/CIDRs allowed to access the server
  (env `LOOM_ONLY_FROM`, empty = no restriction). Blocked API/WebSocket
  requests get a 403 JSON error; blocked page loads get a standalone
  access-denied page. Include `127.0.0.0/8` if local access should keep working.
- `--trusted-proxies` — comma-separated proxy IPs/CIDRs whose `X-Forwarded-For`
  is trusted when resolving the client IP (env `LOOM_TRUSTED_PROXIES`).
  Without this, forwarding headers are ignored entirely (they are trivially
  spoofable) and the TCP peer address is used. Required for `--only-from` to
  see real public IPs when running behind a tunnel/reverse proxy — set it to
  the proxy's ingress address (e.g. `127.0.0.1` for a local tunnel daemon).
- `--2fa` — require TOTP two-factor authentication for login (default `true`,
  env `LOOM_2FA`). With `--2fa=false`, registration skips TOTP enrollment and
  login completes with password only (the login response is `{"status":"ok"}`
  instead of `{"status":"totp_required"}`); `GET /api/auth/config` exposes the
  setting to the SPA.
- `LOOM_AUTH_KEY` — base64-encoded 32-byte AES key used to encrypt TOTP
  secrets at rest (env only, no flag). If unset, a key is generated once and
  stored as `auth.key` beside the database.
- `--env` — path to a `.env` file loaded into the process environment before
  startup (default `.env`, env `LOOM_ENV_FILE`); a missing file is not an
  error. Used for LLM credentials consumed by the Tools module (see below).
- `--python-bin` / `--pandoc-bin` / `--mmdc-bin` — external binaries the Tools
  module shells out to (env `LOOM_PYTHON_BIN` / `LOOM_PANDOC_BIN` /
  `LOOM_MMDC_BIN`). `--python-bin` defaults to `./tools/venv/bin/python3` if
  that venv exists (see Tools module setup below), else `python3` on PATH.
- `--version` — print the running build's version (embedded at build time
  from the git tag, see Versioning below) and exit.
- `--updates` — check the latest GitHub release against the running version
  and, if newer, download and install it in place, then exit (it does not
  restart the server — restart it yourself once it prints the new version).
  Requires `--github-token` / `LOOM_GITHUB_TOKEN` since the release repo is
  private.
- `--github-token` — GitHub token used by `--updates` to read releases and
  download assets from the private repo (env `LOOM_GITHUB_TOKEN`).

## Tools module setup (markitdown, pandoc, mermaid)

The Tools sidebar page (`/w/:wsId/tools`) shells out to three external CLIs —
none have a pure-Go equivalent, so they aren't bundled in the binary:

- **markitdown** (any document → markdown, https://github.com/microsoft/markitdown):
  install into a dedicated venv, since most system Pythons are externally
  managed and block a plain `pip install`:
  ```bash
  cd backend && python3 -m venv tools/venv
  tools/venv/bin/pip install "markitdown[all]" openai pymupdf4llm
  ```
  `openai` is optional — it's only imported if `OPENAI_API_KEY` and
  `MARKITDOWN_LLM_MODEL` are set (see below), enabling LLM-generated image
  descriptions during conversion. `pymupdf4llm` handles the PDF path:
  markitdown's own PDF converter is plain-text extraction (headings, tables,
  and emphasis are lost — its LLM hook never applies to PDFs), so PDFs go
  through pymupdf4llm's layout-aware extraction instead; without it, PDF
  conversion falls back to plain text. `tools/venv/` is gitignored; each
  checkout/deploy needs its own.
- **pandoc** (markdown → docx/pdf): `brew install pandoc` (or see
  https://pandoc.org/installing.html). PDF export uses pandoc's default PDF
  engine — install a LaTeX distribution (e.g. `brew install --cask basictex`)
  if PDF export fails with a missing-engine error.
- **mermaid-cli** (`mmdc`, renders ` ```mermaid ` fenced blocks to PNG before
  the pandoc pass): `npm install -g @mermaid-js/mermaid-cli`.

If a binary is missing, the Tools API responds `503` with an actionable
install command rather than failing silently.

**LLM integration for markitdown** — put credentials in a `.env` file beside
the database (or wherever `--env` points) and they load automatically at
startup via `config.LoadDotEnv` (real environment variables always win over
the file):
```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # optional, for OpenAI-compatible endpoints
MARKITDOWN_LLM_MODEL=gpt-4o-mini
```

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

## Versioning / releases

Every build embeds a version string via `-ldflags -X
loom/backend/internal/version.Version=...`, computed by the `Makefile` from
`git describe --tags --always --dirty` (falls back to `dev` for an untagged
build). `--version` prints it; `--updates` uses it to decide whether a newer
release is available.

To cut a release: push an annotated semver tag (`git tag -a v1.2.3 -m
v1.2.3 && git push origin v1.2.3`). The `release.yml` GitHub Actions workflow
then runs the test suite, `make portable-all`, and publishes a GitHub Release
for that tag with all 6 platform binaries attached.

## Type checking / linting

```bash
# TypeScript
cd frontend && npm run typecheck

# Go
cd backend && go vet ./...
```

`npm run typecheck` always regenerates `routeTree.gen.ts` first (via the
`pretypecheck` script, which runs a throwaway `vite build`) — it's gitignored
and otherwise only exists after `vite dev`/`vite build` has run once, which is
what broke a bare `npm ci && npm run typecheck` in CI.

A pre-commit hook mirrors this locally before every commit. Enable it once
per clone:
```bash
git config core.hooksPath .githooks
```

## Testing

- Backend: `go test ./...` (stdlib testing). The Tools module tests
  (`internal/service/tools_test.go`, `internal/handler/tools_test.go`) shell
  out to the real markitdown/pandoc/mmdc binaries and skip themselves if a
  binary isn't on `PATH`.
- Frontend: no test suite yet; Vitest is the anticipated choice (Vite-native).

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
