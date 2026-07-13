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
5. **Auth: ephemeral per-launch key.** A fresh 32-byte hex key is generated
   each launch and never persisted; it is handed to the SPA once via
   `?key=` on the initial navigation. The backend's existing dual-auth
   `RequireAuth` (session cookie OR bearer hub key) and WS `?key=` support
   make this work with no backend changes.

## Architecture

```
┌─ Loom.app (Tauri v2) ───────────────────────────────┐
│  Rust shell (thin)                                  │
│   1. generate ephemeral key K (32-byte hex)         │
│   2. pick a free localhost port P                   │
│   3. spawn sidecar: loom-server                     │
│        --role hub --addr 127.0.0.1:P --key K        │
│        --db <appDataDir>/loom.db                    │
│        --env <appDataDir>/.env                      │
│        --open=false --2fa=false                     │
│   4. splash window ("Starting Loom…", bundled asset)│
│   5. poll GET /api/health until 200 (15s timeout)   │
│   6. main window → http://127.0.0.1:P/?key=K        │
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

**2. Frontend key mode — `frontend/src/lib/desktopKey.ts` (new, web-safe)**

- At SPA boot (`main.tsx`): read `?key=` from the URL, stash in module state +
  `sessionStorage` (survives in-app reloads), strip it from the URL via
  `history.replaceState`.
- `api.ts`: attach `Authorization: Bearer <key>` to every request when a key
  is present (`RequireAuth` on the hub already accepts it).
- `terminalClient.ts` and the LSP WS client: append `?key=` to WS URLs
  (backend `keyFromRequest` already accepts it on WS upgrades only).
- Auth gate: bearer key passes `RequireAuth`, so the login/TOTP screens are
  skipped in key mode; exact gate wiring verified during implementation.
- No key present → all of this is inert. The web deployment is untouched.

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
  native error dialog showing the last ~20 log lines; app exits after
  dismissal.
- **Port conflict:** retry spawn with a new random port, 3 attempts total.
- **Mid-session crash:** Rust monitors the child; on unexpected exit show a
  dialog offering Restart (re-spawn, re-navigate with a fresh key) or Quit.
- **App quit:** kill the sidecar child (process group on unix, job object /
  taskkill-tree on Windows) so no orphaned Go server keeps running.
- In-webview API errors keep the existing `{"error":"message"}` envelope and
  SPA error states — nothing desktop-specific.

## Testing

- Backend: key-auth paths already covered (`keyauth_test.go`,
  `middleware_test.go`); no backend changes expected.
- Frontend: no test runner exists; `npm run typecheck` gates the
  `desktopKey.ts` change. Manual check that the web flow (no key) is
  unchanged.
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
