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
cd backend && go run ./cmd/server --db devdeck.db --open=false
```

### `devdeck setup` — interactive configuration

```bash
./devdeck setup                       # step-by-step wizard, writes devdeck.yaml
./devdeck setup --config /etc/devdeck.yaml   # write somewhere specific
```

The only subcommand. It configures any role (hub / runtime / both), generates
the API key, pre-fills a runtime's public URL from `tailscale status`, verifies
`hub.url` + `hub.key` against the hub's `/api/whoami` before saving, and prints
the `name|url|key` line for the hub's Machines page (also written to
`copy-this.md`). Nothing touches disk until the review step is confirmed.

Re-running it pre-fills from the existing file, so it is also the reconfigure
path. It requires a real terminal — with stdin or stdout redirected it exits
non-zero rather than hanging. It always exits when done; it never goes on to
start the server.

Launching the binary with no `devdeck.yaml` present opens the wizard
automatically when a terminal is attached; otherwise (service, sidecar, CI) it
writes a commented defaults file, logs the path, and boots normally.

### Configuration precedence

**built-in default → `devdeck.yaml` → `DEVDECK_*` env var → command-line flag**
(later wins). Every flag below has a corresponding YAML key, named in its
`--help` text.

- `--config <path>` — explicit config file; also `DEVDECK_CONFIG`. A path given
  here that does not exist is an error. Without it, DevDeck looks for
  `./devdeck.yaml`, then `devdeck.yaml` beside the executable; finding neither
  is not an error.
- Unknown YAML keys are rejected at startup, naming the key and its line, so a
  typo fails loudly instead of silently doing nothing.
- `devdeck.yaml.example` at the repo root documents every key. The real
  `devdeck.yaml` and `copy-this.md` hold live API keys — written `0600` and
  gitignored.

The Go backend accepts flags:
- `--role` — server role: `hub` (organizational data + machine registry +
  proxy + web UI), `runtime` (headless execution daemon, key auth only), or
  `both` (a hub that also self-registers itself as its own execution
  machine — for solo self-hosting on a fixed address, no separate runtime
  process or manual Machines-page step) (default `hub`, env `DEVDECK_ROLE`).
- `--key` — static API key; required for `--role runtime`/`--role both`,
  optional bearer auth for `--role hub` (desktop clients) (env `DEVDECK_KEY`).
- `--hub-url` — hub base URL this runtime should self-register with on
  startup (env `DEVDECK_HUB_URL`, empty = self-registration disabled).
- `--hub-key` — hub's bearer key, used to authenticate this runtime's
  self-registration call; required if `--hub-url` is set (env `DEVDECK_HUB_KEY`).
- `--public-url` — this runtime's own reachable URL, advertised to the hub
  during self-registration (env `DEVDECK_PUBLIC_URL`, default `http://<--addr>`).
- `--name` — display name for this machine in the hub's Machines UI during
  self-registration (env `DEVDECK_MACHINE_NAME`, default: OS hostname).
- `--addr` — listen address (default `127.0.0.1:8989`, env `DEVDECK_ADDR`)
- `--db` — SQLite path (default `data/devdeck.db` beside the executable, env `DEVDECK_DB`)
- `--jadi` — remote agent registry URL (env `DEVDECK_JADI_URL`, empty = static built-in)
- `--open` — open the embedded UI in the default browser (default true)
- `--only-from` — comma-separated IPs/CIDRs allowed to access the server
  (env `DEVDECK_ONLY_FROM`, empty = no restriction). Blocked API/WebSocket
  requests get a 403 JSON error; blocked page loads get a standalone
  access-denied page. Include `127.0.0.0/8` if local access should keep working.
- `--trusted-proxies` — comma-separated proxy IPs/CIDRs whose `X-Forwarded-For`
  is trusted when resolving the client IP (env `DEVDECK_TRUSTED_PROXIES`).
  Without this, forwarding headers are ignored entirely (they are trivially
  spoofable) and the TCP peer address is used. Required for `--only-from` to
  see real public IPs when running behind a tunnel/reverse proxy — set it to
  the proxy's ingress address (e.g. `127.0.0.1` for a local tunnel daemon).
- `--enable-tailscale-serve` — run `tailscale serve <port>` alongside the
  server, exposing it on your tailnet at `https://<this-machine>.<tailnet>.ts.net`
  (no port suffix — `tailscale serve` fronts it on the tailnet's implicit
  port 443) without a second terminal (default `false`, env
  `DEVDECK_TAILSCALE_SERVE`). Requires the `tailscale` CLI on `PATH`; fails
  fast at startup if it's missing.
- `--2fa` — require TOTP two-factor authentication for login (default `true`,
  env `DEVDECK_2FA`). With `--2fa=false`, registration skips TOTP enrollment and
  login completes with password only (the login response is `{"status":"ok"}`
  instead of `{"status":"totp_required"}`); `GET /api/auth/config` exposes the
  setting to the SPA.
- `DEVDECK_AUTH_KEY` — base64-encoded 32-byte AES key used to encrypt TOTP
  secrets at rest (env only, no flag). If unset, a key is generated once and
  stored as `auth.key` beside the database.
- `--env` — path to a `.env` file loaded into the process environment before
  startup (default `.env`, env `DEVDECK_ENV_FILE`); a missing file is not an
  error. Used for LLM credentials consumed by the Tools module (see below).
- `--python-bin` / `--pandoc-bin` / `--mmdc-bin` — external binaries the Tools
  module shells out to (env `DEVDECK_PYTHON_BIN` / `DEVDECK_PANDOC_BIN` /
  `DEVDECK_MMDC_BIN`). `--python-bin` defaults to `./tools/venv/bin/python3` if
  that venv exists (see Tools module setup below), else `python3` on PATH.
- `--version` — print the running build's version (embedded at build time
  from the git tag, see Versioning below) and exit.
- `--updates` — check the latest GitHub release against the running version
  and, if newer, download and install it in place, then exit (it does not
  restart the server — restart it yourself once it prints the new version).
  Requires `--github-token` / `DEVDECK_GITHUB_TOKEN` since the release repo is
  private.
- `--github-token` — GitHub token used by `--updates` to read releases and
  download assets from the private repo (env `DEVDECK_GITHUB_TOKEN`).
- `--socks5-addr` — listen address for a SOCKS5 forward proxy (env
  `DEVDECK_SOCKS5_ADDR`, empty = disabled); point a browser's SOCKS5 setting
  here to route its traffic through this app.
- `--http-proxy-addr` — listen address for an HTTP/HTTPS forward proxy (env
  `DEVDECK_HTTP_PROXY_ADDR`, empty = disabled); point a browser's HTTP proxy
  setting here.
- `--proxy-key` — credential required by `--socks5-addr`/`--http-proxy-addr`
  (env `DEVDECK_PROXY_KEY`; SOCKS5 password or HTTP `Proxy-Authorization`
  password, any username accepted; empty = no auth). See "Forward proxy for
  remote dev servers" below.

## Hub / runtime roles

One binary, three roles. `--role runtime` requires `--key` (fails fast at
startup otherwise) and serves only `GET /api/health` publicly — every other
route needs the key via `Authorization: Bearer <key>` (or `?key=` on
WebSocket upgrade requests only). `--role hub` (the default) keeps existing
session-cookie auth and additionally accepts `Authorization: Bearer <key>`
as an alternate credential (e.g. for a Tauri desktop client). `--role both`
is a hub that also requires `--key` and self-registers itself as its own
execution Machine on startup — routing is identical to `--role hub`
(execution routes are already registered unconditionally); the only
difference is that self-registration loop. See TUTORIAL.md's
["Deployment modes"](TUTORIAL.md#13-deployment-modes-hub-both-and-desktop)
for when to reach for which.

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

# Solo self-hosting: one process, both roles, self-registered as its own machine:
cd backend && go run ./cmd/server --role both --key soloK --addr 127.0.0.1:9197 --db /tmp/solo.db --open=false

curl -s -H 'Authorization: Bearer soloK' http://127.0.0.1:9197/api/machines  # already includes this process itself
```

See `ARCHITECTURE.md` for the roles paragraph and `CONTRACTS.md` for the
key-auth rules and the machines registry/proxy API shapes.

## Installer scripts

`scripts/install.sh` (Linux/macOS) and `scripts/install.ps1` (Windows) download
a release binary and optionally register the machine as a runtime. They are
published to the public docs site by `.github/workflows/deploy-docs.yml`, so the
one-liner needs no credential to fetch the script — only the binary download is
authenticated.

```bash
# Install only
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh

# Install, then self-register as a runtime and verify it reached the hub
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh

# Pin a version, install somewhere else, write config without starting
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_VERSION=v1.4.0 DEVDECK_INSTALL_DIR=/opt/devdeck \
  DEVDECK_NO_START=1 sh
```

Every variable is listed in [`scripts/README.md`](scripts/README.md). They are
the same `DEVDECK_*` names the server already reads, so the generated
`~/.config/devdeck/runtime.env` can be sourced directly.

No service is installed. A runtime started by the installer does not survive a
reboot; the script prints the command to start it again.

Run the script tests with `sh scripts/test/install_test.sh` and
`shellcheck -s sh scripts/install.sh`.

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
above — that one forwards DevDeck's own API traffic; this one forwards
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

`backend/cmd/mcp-server` exposes DevDeck's issues as MCP tools over stdio, so a
coding agent (e.g. one running inside a DevDeck-managed worktree) can file its
own tickets: `list_projects`, `create_issue` (assignee is required — the
calling agent should ask if it isn't obvious), `upload_attachment` (attaches
a local file and, by default, appends its link to the issue description),
and `mark_issue_done` (moves an issue to `in_review`). It opens the **same**
`--db` file as the main server (WAL mode makes that safe) — point it at
`devdeck.db` beside your running instance, not a separate database.

```bash
cd backend && go run ./cmd/mcp-server --db devdeck.db
# or: make build-mcp   (writes backend/devdeck-mcp-server)
```

Point an MCP client at it, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "devdeck-issues": {
      "command": "/path/to/devdeck-mcp-server",
      "args": ["--db", "/path/to/devdeck.db"]
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

`make build` writes `backend/devdeck-api`. Portable builds are written to `dist/`.
The executable creates `data/devdeck.db` beside itself on first launch. Node.js and
Go are build-time dependencies only; end users still need Git and their selected
coding-agent CLI installed.

## Versioning / releases

Every build embeds a version string via `-ldflags -X
devdeck/backend/internal/version.Version=...`, computed by the `Makefile` from
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
- `make dev-tauri-full` (or `cd frontend && npm run tauri:dev-full`) — same
  desktop shell, but exercises the real hub-mode chooser / sidecar
  spawn-respawn loop / Tailscale remote-runtime code instead of skipping it.
  `DEVDECK_TAURI_DEV_FULL=1` lets `setup()` in `lib.rs` past the
  `cfg!(debug_assertions)` guard, and `tauri.dev-full.conf.json` drops
  `devUrl`/`beforeDevCommand` (so Tauri serves `frontendDist`'s
  placeholder/choose/error pages itself, same as a production install,
  instead of starting Vite + a `--role both` Go backend) and overrides
  `identifier` to `dev.kiyora.devdeck.devfull` so its app-data dir
  (`hub-mode.json`, `devdeck.db`, `runtime-key`) never collides with a real
  installed app's. Trade-off: no frontend HMR — the sidecar serves whatever
  `prepare-webui` last built into `backend/internal/webui/dist`, so re-run
  the target after frontend changes you want to see.
- `make e2e-tauri-smoke` (or `frontend/src-tauri/scripts/e2e-smoke.sh`) — a
  scripted smoke test of `dev-tauri-full`'s real local-hub-mode flow: builds
  a plain, non-watching debug binary (`tauri build --no-bundle --debug
  --config tauri.e2e.conf.json`, its own throwaway `dev.kiyora.devdeck.e2e`
  identifier so it never collides with a developer's `dev-tauri-full`
  session or a real installed app), pre-seeds `hub-mode.json` so the
  choose-hub-mode screen is skipped, then launches the built app and
  observes sidecar spawn → `/api/health` → machine registration
  (`local-machine-id` matching `^m-[0-9a-f]+$`) → clean process teardown
  (confirms the `devdeck-server` child also exits, no orphan) end to end,
  printing a PASS/FAIL per step. **macOS only for now**, and it deliberately
  does **not** cover the one thing that still needs a human: visually
  confirming `choose.html` itself renders correctly — that stays a manual,
  one-glance check via `make dev-tauri-full`, unaffected by this target. Not
  part of `test`/`lint` (needs a full Tauri/Cargo build and a real Go
  sidecar build), so it's opt-in. See
  `docs/superpowers/specs/2026-07-17-tauri-desktop-e2e-smoke-harness-design.md`.
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
  `~/Library/Application Support/dev.kiyora.devdeck/` — `devdeck.db`, `.env`,
  `local-machine-id`); sidecar logs in the app log dir (`sidecar.log`).
- **Two hub modes, chosen on first launch** (revisit anytime via the app
  menu's "Change Hub…"): "Host locally" spawns the bundled sidecar as
  `--role hub` (as above), or "Connect to a hub" points the window at an
  operator-hosted hub URL + key instead — no sidecar hub spawned, the
  window just behaves like a browser tab against that hub's own login.
- **"Connect to a hub" also self-registers this device as a runtime.** In
  the background (never blocking the window's navigation), the shell
  shells out to `tailscale status --self --json` for this device's tailnet
  DNS name, then — if found — spawns the bundled backend as a *second*,
  separate `--role runtime` process (persisted key at `<app data
  dir>/runtime-key`, own `devdeck-runtime.db`, `--enable-tailscale-serve`) that
  self-registers with the hub URL/key you provided. If Tailscale isn't
  available, this step is skipped and logged to `<app log
  dir>/runtime-sidecar.log`; the app menu swaps "Change Hub…" for "⚠ Runtime
  not registered" until it's resolved. See
  `docs/superpowers/specs/2026-07-16-desktop-remote-runtime-self-registration-design.md`.
