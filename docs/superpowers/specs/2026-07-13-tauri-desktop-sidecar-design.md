# Loom Desktop (Tauri v2, bundled hub sidecar) — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete)
**Supersedes:** the "Tauri shell" / sub-project #3 section of
`2026-07-09-hub-runtime-tauri-design.md`. That spec assumed a thin desktop
client that connects to a remote hub; this spec replaces it with a
self-contained desktop app that bundles the hub as a sidecar. Everything the
old spec shipped (role split, key auth, machine registry, proxy, frontend
machine client layer) is reused as-is.

## Goal

Ship Loom as a native desktop app (macOS, Windows, Linux) that works
standalone out of the box: the Tauri shell spawns the existing Go backend as a
bundled sidecar in `--role hub` mode, and the webview loads the SPA the Go
binary already embeds. The desktop UI is byte-identical to `frontend/`.
Remote runtime machines still federate through the existing Machines page —
the bundled hub is a full hub.

## Decisions (from brainstorming)

1. **Backend model: sidecar.** The Go backend ships inside the app bundle and
   is spawned on launch (localhost, auto-generated key). Chosen over a thin
   remote-hub client and over a dual-mode launcher.
2. **Repo layout:** `frontend/src-tauri/` next to the existing Vite app —
   standard Tauri layout, one codebase builds web + desktop, zero duplication.
3. **v1 platforms:** macOS Apple Silicon (`aarch64-apple-darwin`),
   Windows x64 (`x86_64-pc-windows-msvc`), Linux x64
   (`x86_64-unknown-linux-gnu`). The other three triples (macOS Intel,
   Windows ARM, Linux ARM) are one Makefile line each, later.
4. **UI loading: webview → sidecar URL.** The window loads
   `http://127.0.0.1:<port>/` served by the sidecar's embedded `webui`
   package. Same-origin `/api` + `/ws/*`: no CORS, no API-base plumbing, UI
   and backend versions can never diverge. Chosen over bundling the Vite dist
   under `tauri://localhost`.
5. **Auth: ephemeral per-launch key, exchanged for a session.** A fresh
   32-byte hex key is generated each launch and never persisted; it is handed
   to the SPA once via `?key=` on the initial navigation. The SPA immediately
   exchanges it for a normal session cookie via a new hub endpoint
   `POST /api/auth/key-session` (see below), after which every surface —
   login gate, `<img>` attachments, REST, WS — behaves exactly like the web.
   Chosen over bearer-header plumbing during planning: `<img
   src="/api/attachments/{id}">` cannot carry an Authorization header, and
   the backend deliberately accepts `?key=` only on WS upgrades.

## Architecture

```
┌─ Loom.app (Tauri v2) ───────────────────────────────┐
│  Rust shell (thin)                                  │
│   1. generate ephemeral key K (32-byte hex)         │
│   2. spawn sidecar: loom-server                     │
│        --role hub --addr 127.0.0.1:0 --key K        │
│        --db <appDataDir>/loom.db                    │
│        --env <appDataDir>/.env                      │
│        --open=false --2fa=false                     │
│        --secure-cookies=false                       │
│   3. parse bound port P from the sidecar's          │
│      "loom listening on http://127.0.0.1:P" line    │
│      (race-free — the OS picks the port)            │
│   4. splash window ("Starting Loom…", bundled asset)│
│   5. poll GET /api/health until 200 (15s timeout)   │
│   6. upsert local Machine {hostname, URL, key K}    │
│   7. main window → http://127.0.0.1:P/?key=K        │
│      (SPA exchanges K for a session cookie via      │
│       POST /api/auth/key-session, then strips ?key) │
│                                                     │
│  Webview                                            │
│   UI: served by Go (embedded webui, SPA fallback)   │
│   /api        ── same origin ──► sidecar            │
│   /ws/terminal ─ same origin ──► sidecar            │
│   /ws/lsp      ─ same origin ──► sidecar            │
└─────────────────────────────────────────────────────┘
         │ Machines page (existing federation)
         ▼
  Remote runtimes (--role runtime --key …) — unchanged
```

### Components

**1. Tauri shell — `frontend/src-tauri/` (new)**

- Tauri v2, identifier `dev.kiyora.loom`, product name "Loom".
- Sidecar declared as `externalBin` (`binaries/loom-server`); Tauri resolves
  the platform binary by target-triple suffix at bundle time.
- Rust responsibilities are deliberately minimal: key generation, free-port
  selection, sidecar spawn/monitor/kill, health poll, window management,
  sidecar log capture. No business logic ever lives in Rust.
- Splash window content is a static HTML page in the Tauri `frontendDist`
  placeholder directory (the real UI comes from the sidecar).

**2. Backend key→session bootstrap — `POST /api/auth/key-session` (new)**

- Registered only when `--role hub` **and** `--key` is non-empty. The handler
  re-verifies the bearer key itself (constant-time), independent of the
  middleware pass.
- Service method `AuthService.KeySession()`: if `UserCount() == 0`, create
  the local operator (`operator@loom.desktop`, crypto-random password) and
  issue a session directly (no TOTP — the caller already proved key
  possession); otherwise issue a session for the existing single-operator
  user (`UserByEmail`, fixed desktop email). Returns `(sessionToken, user)`.
- Handler sets the normal `loom_session` cookie (30 days) and returns the
  user JSON. From then on the desktop SPA is indistinguishable from a
  logged-in web session — login gate, attachments, everything.
- Cookie caveat: `setAuthCookie` hardcodes `Secure: true`, which
  WKWebView/WebKitGTK may reject over plain `http://127.0.0.1`. New flag
  `--secure-cookies` (default `true`; the sidecar passes
  `--secure-cookies=false`). Web deployments are unchanged by the default.

**2b. Frontend bootstrap — `main.tsx` (tiny, web-safe)**

- Before rendering: read `?key=` from the URL; if present, strip it via
  `history.replaceState`, then `POST /api/auth/key-session` with
  `Authorization: Bearer <key>`; render the app afterwards. The root-route
  guard's `ensureQueryData(meQueryOptions)` then succeeds normally.
- No key present → no fetch, render immediately. The web deployment is
  untouched. No changes to `api.ts`, WS clients, or the route guard.

**2c. Local machine registration — Tauri shell (new)**

- Terminals, LSP, files, and git all resolve through a registered `Machine`
  (`machines.find(m => m.id === project.machineId)`); without one the UI
  shows "no machine assigned". The desktop hub must therefore appear in its
  own machine registry.
- After the health poll, the Rust shell upserts the local machine via the
  hub API (Bearer key): `PATCH /api/machines/{savedId}` with
  `{"url": "http://127.0.0.1:<port>", "key": "<launch key>"}` when
  `<appDataDir>/local-machine-id` exists and the PATCH returns 200;
  otherwise `POST /api/machines` with
  `{"name": "<hostname>", "url": ..., "key": ...}` and save the returned
  `id` to `<appDataDir>/local-machine-id`.
- With the entry in place, the existing direct-first machine client handles
  all WS/REST against the local hub (`?key=` on WS upgrades) — zero frontend
  changes for terminals.

**3. Sidecar build pipeline — Makefile (extend)**

- New target `prepare-sidecar`: run the existing frontend build +
  `prepare-webui` (embeds dist into the Go binary), then reuse the existing
  `CGO_ENABLED=0` cross-compile recipes to produce the three v1 binaries,
  copied to `frontend/src-tauri/binaries/loom-server-<triple>[.exe]`
  (directory gitignored).
- Pure-Go SQLite (`modernc.org/sqlite`) means no CGO toolchains are needed —
  the Makefile already cross-compiles all targets today.

**4. npm scripts — `frontend/package.json` (extend)**

- `tauri:dev` → `tauri dev`: `beforeDevCommand` runs the existing
  `npm run dev` (Vite + local Go), `devUrl` `http://localhost:5173`, normal
  login flow. Fast iteration; no sidecar rebuild, no key mode.
- `tauri:build` → `tauri build` with `beforeBuildCommand` invoking
  `make prepare-sidecar`. Produces `.dmg`/`.app`, NSIS `.exe`, `.deb` +
  `.AppImage`.

## Data locations (desktop)

- Database: `<appDataDir>/loom.db` (Tauri app-data dir, passed via `--db`) —
  isolated from any dev instance.
- Optional env file: `<appDataDir>/.env` (missing file is not an error —
  existing backend behavior).
- Sidecar logs: `<appLogDir>/sidecar.log`, stdout/stderr appended; truncate
  when the file exceeds 5 MB at startup (no rotation machinery for v1).

## Error handling & lifecycle

- **Startup failure** (sidecar exits early, or health not 200 within 15 s):
  the window navigates to a bundled `error.html` naming the sidecar log path
  (in-window error page; avoids an extra dialog-plugin dependency).
- **Port conflict:** impossible by construction — `--addr 127.0.0.1:0` lets
  the OS assign the port, and the shell parses it from the listen log line.
- **Mid-session crash:** Rust monitors the child; on unexpected exit it
  auto-respawns (fresh key, machine re-upsert, window re-navigated) up to 3
  times, then shows the error page.
- **App quit:** kill the sidecar child (process group on unix, job object /
  taskkill-tree on Windows) so no orphaned Go server keeps running.
- In-webview API errors keep the existing `{"error":"message"}` envelope and
  SPA error states — nothing desktop-specific.

## Testing

- Backend: TDD the new surface — `key-session` handler tests (valid key →
  cookie + user, wrong/missing key → 401, first-run user creation,
  idempotency on second call) and the `--secure-cookies` wiring; existing
  key-auth tests (`keyauth_test.go`, `middleware_test.go`) keep passing.
- Frontend: no test runner exists; `npm run typecheck` gates the `main.tsx`
  bootstrap change. Manual check that the web flow (no key) is unchanged.
- Rust: kept thin enough that unit tests are limited to pure helpers (port
  pick, arg construction); the real gate is the end-to-end smoke test.
- E2E smoke (manual or webapp-testing-driven): built app launches, splash →
  UI, project list loads, terminal connects, app quit leaves no `loom-server`
  process behind.

## Out of scope (v1)

- macOS Intel, Windows ARM, Linux ARM sidecar targets (trivial to add later).
- Auto-update of the desktop app (the backend's `--updates` self-update flow
  is not wired into the bundle).
- Tray icon, native notifications, global shortcuts, deep links.
- Code signing / notarization pipelines (build unsigned artifacts first).
- "Connect to remote hub" thin-client mode — the sidecar hub already
  federates remote runtimes via the Machines page; a remote-hub mode can be
  layered on later without touching this design.
- Any change to terminal WS framing/compression (production tunnel depends on
  it).
