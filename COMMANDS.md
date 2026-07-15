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
- `--role` — server role: `hub` (organizational data + machine registry +
  proxy + web UI) or `runtime` (headless execution daemon, key auth only)
  (default `hub`, env `LOOM_ROLE`).
- `--key` — static API key; required for `--role runtime`, optional bearer
  auth for `--role hub` (desktop clients) (env `LOOM_KEY`).
- `--hub-url` — hub base URL this runtime should self-register with on
  startup (env `LOOM_HUB_URL`, empty = self-registration disabled).
- `--hub-key` — hub's bearer key, used to authenticate this runtime's
  self-registration call; required if `--hub-url` is set (env `LOOM_HUB_KEY`).
- `--public-url` — this runtime's own reachable URL, advertised to the hub
  during self-registration (env `LOOM_PUBLIC_URL`, default `http://<--addr>`).
- `--name` — display name for this machine in the hub's Machines UI during
  self-registration (env `LOOM_MACHINE_NAME`, default: OS hostname).
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
- `--socks5-addr` — listen address for a SOCKS5 forward proxy (env
  `LOOM_SOCKS5_ADDR`, empty = disabled); point a browser's SOCKS5 setting
  here to route its traffic through this app.
- `--http-proxy-addr` — listen address for an HTTP/HTTPS forward proxy (env
  `LOOM_HTTP_PROXY_ADDR`, empty = disabled); point a browser's HTTP proxy
  setting here.
- `--proxy-key` — credential required by `--socks5-addr`/`--http-proxy-addr`
  (env `LOOM_PROXY_KEY`; SOCKS5 password or HTTP `Proxy-Authorization`
  password, any username accepted; empty = no auth). See "Forward proxy for
  remote dev servers" below.

## Hub / runtime roles

One binary, two roles. `--role runtime` requires `--key` (fails fast at
startup otherwise) and serves only `GET /api/health` publicly — every other
route needs the key via `Authorization: Bearer <key>` (or `?key=` on
WebSocket upgrade requests only). `--role hub` (the default) keeps existing
session-cookie auth and additionally accepts `Authorization: Bearer <key>`
as an alternate credential (e.g. for a Tauri desktop client).

```bash
# Start a headless runtime daemon:
cd backend && go run ./cmd/server --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false

curl -s http://127.0.0.1:9199/api/health                                          # 200 (public)
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9199/api/workspaces        # 401 (no key)
curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer rtk' \
  http://127.0.0.1:9199/api/workspaces                                            # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9199/api/auth/config       # 404 (route absent on runtime)

# Start a runtime that self-registers with a hub instead of being added
# manually through the Machines UI:
cd backend && go run ./cmd/server --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --hub-url http://127.0.0.1:9198 --hub-key hubk --public-url http://127.0.0.1:9199 --name my-laptop

curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines  # already includes "my-laptop"

# Start a hub with dual auth (session cookie OR bearer key):
cd backend && go run ./cmd/server --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/hub.db --open=false

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9198/api/workspaces        # 401 (no cookie, no key)
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/workspaces       # 200 []
```

See `ARCHITECTURE.md` for the roles paragraph and `CONTRACTS.md` for the
key-auth rules and the machines registry/proxy API shapes.

## Forward proxy for remote dev servers (SOCKS5 / HTTP)

A worktree's own dev server (e.g. `npm run dev` inside an agent-spawned
worktree) binds to `127.0.0.1` on whichever machine it's running on. If
that's a remote runtime (over Tailscale), your local browser can't reach it
directly — it's loopback-only on the other end. `backend/internal/netproxy`
(`socks5.go`, `httpproxy.go`) solves this the same way `ssh -D` does: it runs
a plain SOCKS5 and/or HTTP forward proxy *on the runtime*, so a browser that
points its proxy settings at the runtime dials out from the runtime's own
network namespace — reaching that machine's `127.0.0.1:5173` (or any other
loopback port) as if the browser were running there. This is unrelated to
the `/api/machines/.../proxy` REST/WS reverse proxy in "Hub / runtime roles"
above — that one forwards Loom's own API traffic; this one forwards
arbitrary browser traffic the user points at it. Neither listener is a
route on the main API mux — both are separate `net.Listen`/`http.Server`
TCP listeners, opt-in via empty-string-disables flags, started from
`startForwardProxies` in `main.go`.

```bash
# On the runtime machine (or locally, for testing):
cd backend && go run ./cmd/server --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --socks5-addr 127.0.0.1:1080 --http-proxy-addr 127.0.0.1:8080 --proxy-key pxk

# Point curl (or the browser's proxy settings) at either listener:
curl --socks5 pxk:pxk@127.0.0.1:1080 http://127.0.0.1:5173/          # via SOCKS5 (any username, proxy-key as password)
curl -x http://pxk:pxk@127.0.0.1:8080 http://127.0.0.1:5173/         # via HTTP proxy (Proxy-Authorization: Basic)
curl -x http://pxk:pxk@127.0.0.1:8080 https://example.com/           # HTTPS via CONNECT tunnel
```

Both proxies are CONNECT-only forwarders (SOCKS5: no BIND/UDP ASSOCIATE) —
not an anonymization or security tool, just a way to reach a loopback-bound
service on whichever machine the process is running on. An empty
`--proxy-key` means no auth at all; set one whenever the listen address is
reachable beyond your own machine (e.g. `127.0.0.1` bound but exposed over a
tailnet-forwarded port, or a non-loopback `--socks5-addr`).

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
then runs the test suite, `make portable-all` (backend runtime/hub binaries)
and a macOS/Linux/Windows Tauri desktop build in parallel, and publishes a
GitHub Release for that tag with all 6 platform binaries plus the desktop
installers (`.dmg`, `.deb`/`.rpm`/`.AppImage`, `.msi`/`.exe`) attached.

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
- The frontend dev server proxies `/api`, `/ws/terminal`, and `/ws/ssh` to the
  Go backend (configured in `vite.config.ts`). Ensure the backend is running
  on the expected port.
- Node.js terminal gateway (`frontend/server/terminal-server.mjs`) is legacy;
  the canonical terminal server is the Go `internal/terminal` package.

## Desktop app (Tauri)

- `make dev-tauri` (or `cd frontend && npm run tauri:dev`) — desktop shell in
  dev mode: builds the host-triple sidecar (`make sidecar-host`, required or
  tauri-build fails), then opens a native window on the Vite dev server
  (`beforeDevCommand` in `tauri.conf.json` runs `npm run dev`, which also
  starts the Go backend as `--role both` — no separate `make dev`/`dev-api`
  needed). This is normal username/password login, not the release sidecar's ephemeral-key
  bootstrap (`setup()` in `lib.rs` skips spawning the sidecar entirely when
  `cfg!(debug_assertions)` is true).
- The dev backend (`dev:api` in `frontend/package.json`, and `make
  dev-api`/`dev-hub`) always passes `--secure-cookies=false`. Without it,
  login appears to succeed but every following request 401s: WebKit's
  WKWebView (used by the Tauri window, unlike Chrome) drops `Secure` cookies
  set over plain `http://localhost`, silently losing the session. Same root
  cause as the release sidecar's `--secure-cookies` flag — see "Key auth
  (hub/runtime roles)" above.
- `cd frontend && npm run tauri:build` — full release build: web UI →
  embedded into the Go sidecars (`make prepare-sidecar`, 3 target triples) →
  platform bundles under `frontend/src-tauri/target/release/bundle/`.
- Desktop data lives in the app-data dir (macOS:
  `~/Library/Application Support/dev.kiyora.loom/` — `loom.db`, `.env`,
  `local-machine-id`); sidecar logs in the app log dir (`sidecar.log`).
