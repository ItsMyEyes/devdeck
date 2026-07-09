# Loom Hub + Runtime + Tauri Desktop — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming complete)

## Goal

Split the Loom backend into two roles — a **hub** (organizational source of truth)
and per-machine **runtimes** (execution: git, worktrees, PTY, agents) — so each
machine only deploys a headless backend authenticated by a static `--key`. The
frontend ships in two versions from one codebase: the existing **web** SPA
(served by the hub, unchanged auth) and a new **Tauri desktop** app that connects
to the hub by URL + key.

## Decisions (from brainstorming)

1. **Multi-machine model:** all machines visible simultaneously in one UI (not a
   single-active-machine switcher).
2. **Machine ↔ workspace relationship:** workspace stays the top-level
   organizational concept; a machine is an execution resource usable from any
   workspace. A project points to `machineId + path`, so one workspace can hold
   projects living on different machines.
3. **Source of truth:** one backend instance is designated the **hub** and stores
   all organizational data. Runtimes store nothing organizational.
4. **Traffic path:** **direct-first** — all nodes live on one Tailscale tailnet,
   so clients talk straight to each runtime over p2p WireGuard (terminal WS
   especially: one hop). The hub proxy exists only as a fallback (NAT traversal
   degraded, or CORS-constrained contexts).
5. **Two frontend versions:** web SPA stays alive (served by hub, accessed via
   browser/tunnel) alongside the Tauri desktop app. Same codebase, runtime mode
   detection.
6. **Auth:**
   - **Runtime:** Bearer `--key` only. No user table, no login, fully headless.
   - **Hub:** dual — existing session auth (register/login/TOTP/Turnstile,
     cookie) for the web SPA **or** Bearer `--key` for the desktop app. One
     middleware accepts either.
7. **Machine enrollment:** machines are registered through the UI (name + URL +
   runtime key), stored in the hub registry. Runtimes do not self-register.
8. **Networking:** everything rides the tailnet — no public tunnel, no exposed
   ports. Machine URLs are MagicDNS names (`machine-a.tail-xxxx.ts.net`).
9. **Tailscale integration:** host `tailscaled` on every machine (no embedded
   tsnet). The backend binds to the tailscale interface and reuses the existing
   `--enable-tailscale-serve` flag on the hub for valid TLS certs.
10. **Editing model:** the in-app editor is the primary editing surface and
    will be strengthened (no VS Code deep-link integration). LSP servers keep
    running runtime-side next to the files — the same model as VS Code
    Remote-SSH — reached over the direct-first WS path. No local file sync.

## Architecture

```
                    ┌────────────── one Tailscale tailnet ──────────────┐

Tauri Desktop App ──(hub ts.net URL + hub key)──┐
Web SPA (browser) ──(cookie session)────────────┤
        │                                       ▼
        │                            Hub backend (1 instance)
        │                            - workspaces, projects, todos, invoices,
        │                              news, companies, banks, issues, settings
        │                            - machine registry {id, name, url, key}
        │                            - proxy: /api/machines/:id/proxy/* → runtime
        │                              (FALLBACK path only)
        │                                       │
        │    direct-first: p2p WireGuard,       │
        │    1 hop (REST + terminal WS)         │
        ▼                                       ▼
       Runtime machines A / B / C  (MagicDNS: machine-x.tail-xxxx.ts.net)
       fs / git / worktrees / PTY terminal / LSP / agents / tools
```

### Backend: one binary, two roles

- `loom --role hub --key <hubkey>` — organizational routes + machine registry +
  proxy + embedded SPA + session auth endpoints.
- `loom --role runtime --key <runtimekey>` — execution routes only (fs, git,
  worktrees, terminal WS, LSP WS, agents, tools). No SPA, no auth endpoints.
- Existing flags (`--only-from`, `--trusted-proxies`, `--client-ip-header`,
  tunnel-related behavior) remain as additional layers on both roles.
- Terminal WS coalescing + compression negotiation is **not touched** (required
  for the production tunnel setup).

### Auth details

- REST with key: `Authorization: Bearer <key>`, constant-time compare.
- WS with key: `?key=` query param (browser WebSocket API cannot set headers).
- Web SPA WS: cookie, same-origin — current behavior, unchanged.
- Hub middleware: valid session cookie OR valid bearer hub key.
- Runtime middleware: valid bearer runtime key only.
- Key distribution: `GET /machines` on the hub returns each machine's URL and
  runtime key to an already-authenticated client. Tauri stores them in the OS
  keychain; the web SPA keeps them in memory only (never localStorage).
- Security layering (defense in depth): tailnet membership (WireGuard) →
  Tailscale ACLs → app-layer key. Turnstile on web login becomes optional since
  the hub is no longer publicly reachable.

### Machine registry & proxy (hub)

- Registry entries: `{id, name, url, key}` — `url` is the runtime's MagicDNS
  name. CRUD via hub API, managed from a new **Machines** page in the UI (both
  versions).
- Clients connect **direct** to `url` with the distributed runtime key.
- Proxy fallback: `/api/machines/:id/proxy/*` forwards REST and WS to the
  runtime, injecting the runtime key server-side. Used only when the direct
  connection fails (per-machine health checks drive the switch and the
  online/offline indicators, and surface which path is active).

### Networking (Tailscale)

- Every node — operator devices, hub host, runtime hosts — joins one tailnet
  via host `tailscaled`. No public tunnel, no exposed ports, no port forwarding.
- Tailscale ACLs with tags gate reachability at the network layer:
  ```jsonc
  {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:loom-hub:8989"]},
  {"action": "accept", "src": ["tag:loom-hub"],     "dst": ["tag:loom-runtime:8989"]},
  {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:loom-runtime:8989"]}
  ```
- Backends bind to the tailscale interface and set `--only-from 100.64.0.0/10`
  so non-tailnet traffic is refused even if misbound (flag already exists).
- Hub runs with `--enable-tailscale-serve` (existing flag) for a valid TLS cert
  on its `ts.net` name; the web SPA is browsed at `https://hub.tail-xxxx.ts.net`
  from any tailnet device, including mobile.
- Runtimes must set CORS allowlists for the hub origin (web SPA calling
  cross-origin) and the Tauri origins.

### Domain model change

- `Project` gains `machineId`; its `path` is interpreted on that machine.
- Organizational tables (workspaces, projects metadata, todos, invoices, news,
  companies, banks, issues, settings, users/sessions) exist only in the hub DB.
- Execution state (worktrees runtime state, PTY sessions) lives on runtimes.

### Frontend refactor

- Replace single relative `API_BASE` (`frontend/src/lib/api.ts`) with a client
  layer: `hubClient` (base = `''` same-origin on web, configured absolute URL on
  desktop) and `machineClient(machineId)` (resolves to the machine's direct
  MagicDNS URL, falling back to the hub proxy path per health state).
- `terminalClient.ts` and `lspClient.ts` stop deriving WS URLs from
  `window.location.host`; they take the resolved base from the client layer.
- TanStack Query keys gain a `machineId` dimension for all runtime-scoped
  resources (worktrees, git, files, agents).
- Mode detection: `window.__TAURI__` present → desktop mode (skip login, show
  "Connect to Hub" screen, keys in OS keychain via Tauri). Otherwise web mode
  (existing login/TOTP screens, cookies).
- New **Machines** page: list, add/remove, online/offline status. Machine badge
  on projects.

### Tauri shell

- Tauri v2 wrapping the same built SPA. Rust side is shell-only: window +
  secure storage (keychain) for hub key and any direct-mode runtime keys.
- CORS on hub/runtime: allowlist `tauri://localhost` and
  `http://tauri.localhost` (Windows).

## Error handling

- Machine offline: UI shows per-machine offline state; that machine's projects
  render disabled/stale, other machines unaffected (partial failure is visible,
  never global).
- Hybrid fallback: direct connection failure automatically retries via hub
  proxy; surface which path is active in the Machines page.
- Proxy errors from runtimes pass through the existing `{"error":"message"}`
  envelope; the hub maps unreachable-runtime to a distinct error so the client
  can tell "machine down" from "request invalid".

## Testing

- Backend sub-project is fully testable via curl/httptest without any frontend:
  key middleware (both roles), registry CRUD, proxy forwarding (REST + WS),
  hybrid health endpoints.
- Frontend sub-project is testable in a normal browser against a local hub +
  one local runtime before Tauri exists.
- Existing WS compression/mobile regression tests must keep passing.

## Sub-projects (build order)

1. **Backend:** `--key` auth, role split (hub/runtime), machine registry,
   proxy (REST + WS), health checks. Dual-auth middleware on hub.
2. **Frontend:** client layer (hub/machine clients), `machineId` scoping,
   Machines page, Connect-to-Hub screen, mode detection.
3. **Tauri:** shell, secure storage, per-OS builds.

Each sub-project gets its own implementation plan; #1 first.

## Out of scope

- Runtime self-registration to the hub.
- Sync/replication between hub instances.
- Mobile app.
- Changing terminal WS framing/compression behavior.
- Editor UX strengthening (richer LSP features, multi-file editing comfort) —
  agreed direction, but a separate follow-up project after sub-project #3; this
  migration only re-points the existing LSP WS at the machine client layer.
- VS Code / external editor integration — explicitly rejected.
- Local file sync to the operator device — explicitly rejected (conflicts with
  agents writing runtime-side).
