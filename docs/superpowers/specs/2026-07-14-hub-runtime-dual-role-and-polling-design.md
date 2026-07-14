# Hub/Runtime Dual-Role, Remote Hub Connect, and Hub-Side Polling — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming complete)

## Goal

Three related gaps in the existing hub/runtime split
(`docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md`,
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`,
`docs/superpowers/specs/2026-07-13-tauri-desktop-sidecar-design.md`):

1. Today, running both hub and execution duty on one machine requires either
   the Tauri desktop app (whose Rust shell manually upserts a local Machine
   entry) or two separate processes (`--role hub` + `--role runtime`). A
   solo operator self-hosting one plain server has no equivalent — they'd
   need to hand-run two processes for one machine.
2. The Tauri desktop app always spawns its own local sidecar hub. There is
   no way to point the desktop app at a hub the operator already hosts
   elsewhere on their tailnet (explicitly deferred as "out of scope v1" in
   the sidecar design).
3. Machine health (`GET /api/machines/{id}/health`) is a live, on-demand
   ping driven entirely by the browser (one poll per visible row on the
   Machines page, every 15s, only while that page is open). There is no
   server-side awareness of machine status independent of a client tab
   being open.

This project closes all three gaps in one pass, since they share the same
motivation (host the hub somewhere real, point clients at it, keep tabs on
runtimes) and touch overlapping code (`main.go` role wiring, the Machines
page, machine health).

## Decisions (from brainstorming)

1. **Dual-role process:** new `--role both` value. Routing is unchanged
   from `--role hub` (execution routes are already registered
   unconditionally today); the only new behavior is self-registering the
   process as a Machine in its own registry at startup, so it's immediately
   usable as a project's execution machine with no separate runtime process
   and no manual Machines-page step.
2. **Desktop hub mode:** a first-run choice — "Host locally" (today's
   sidecar, unchanged: still `--role hub` with its existing self-upsert —
   see note below on why it can't switch to `--role both`) or "Connect to
   a hub" (operator-supplied tailnet URL; the window simply navigates
   there and behaves like a browser tab against that hub's existing web
   SPA/session-cookie login). Remembered per install, with a way to switch
   back.

   **Note:** `--role both`'s self-registration matches an existing Machine
   row by URL (see below). The sidecar binds `--addr 127.0.0.1:0` — a
   fresh OS-assigned port every launch — so URL-matching would create a
   new duplicate row on every launch instead of updating one. This is
   exactly why the sidecar's existing upsert
   (`frontend/src-tauri/src/hubapi.rs`) persists a `local-machine-id` file
   instead of matching by URL. `--role both` is for fixed-address
   deployments (a plain server with a stable `--addr`/`--public-url`) —
   the sidecar keeps its own mechanism and does not adopt `--role both`.
3. **Hub-side polling:** a background goroutine on hub/both roles pings
   every registered machine's `/api/health` every 15s (matching today's
   client poll cadence, just server-side and de-duplicated), caching
   `{status, latencyMs, lastCheckedAt}` in memory. The existing
   `GET /api/machines/{id}/health` endpoint serves from that cache
   (falling back to one live check on a cache miss), so the frontend needs
   no changes.
4. **Networking model unchanged:** everything still rides one Tailscale
   tailnet, per the original design's decision #8. "Hosting the hub on a
   server" means that server is just another tailnet member (e.g. a cheap
   VPS running `tailscaled`) — not public-internet exposure. No new TLS,
   auth hardening, or rate-limiting is introduced by this project.

## Architecture

### 1. `--role both`

- New allowed value for the existing `--role` flag (`backend/cmd/server/
  main.go:55`), alongside `hub` and `runtime`.
- Routing: identical to `--role hub` today — execution routes (fs, git,
  worktrees, files, terminal WS, LSP WS) are already registered
  unconditionally (`main.go:258-388`); only auth-bootstrap, machine
  registry/proxy, seed, and browser-proxy routes are hub-only
  (`main.go:243-256, 363-382`). `--role both` keeps all of those. Auth
  middleware is hub's dual-auth (`RequireAuth`: session cookie or bearer
  key), same as `--role hub`.
- Startup requirement: `--role both` requires `--key`, same fail-fast
  check as `--role runtime` today (`main.go:96-97`) — the self-registered
  Machine entry needs a key, and there is no reason to run this mode
  without one.
- Self-registration: reuse `machineclient.RunSelfRegisterLoop` (`backend/
  internal/machineclient/selfregister.go:42-78`) completely as-is — the
  same idempotent upsert-by-URL logic a remote runtime already uses to
  register with a hub, just pointed at itself. Broaden the launch
  condition at `main.go:436` (currently `isRuntime && *hubURL != ""`) to
  also fire when `role == "both"`; when `role == "both"` and `--hub-url`
  is unset, default it to `"http://" + *addr` and default `--hub-key` to
  `*apiKey` (mirrors the existing `--public-url` defaulting pattern at
  `main.go:104-105`).
- Net result: one binary, one `--key`, one port, self-registered as a
  Machine — organizational data, execution, and a usable machine entry in
  a single process, no Tauri shell required.

### 2. Tauri desktop — "Connect to a hub"

- First-run screen (new, `frontend/src-tauri/`): two choices.
  - **Host locally** — exactly today's spawn-a-sidecar flow from the
    sidecar design (`--role hub`, ephemeral key, the existing bespoke
    `hubapi::upsert_local_machine` upsert against a persisted
    `local-machine-id` file). Completely unchanged by this project — see
    the decision note above on why it can't move to `--role both`.
  - **Connect to a hub** — operator types a hub URL (tailnet address). No
    sidecar is spawned. The main window navigates directly to that URL;
    the remote hub already serves its own embedded SPA with full
    session-cookie auth (login, TOTP), so the desktop window behaves like
    a plain browser tab pointed at that hub. Zero frontend/SPA code
    changes — only the Rust shell changes (skip sidecar spawn, navigate to
    the operator-supplied URL).
- The choice is persisted in a local Tauri config file (not the OS
  keychain — a URL isn't a credential) so subsequent launches skip the
  choice screen. A "Change hub" / "Disconnect" action returns to it.

### 3. Hub-side polling

- New background goroutine, started only when role is `hub` or `both`,
  ticking every 15s (matching the frontend's existing
  `refetchInterval: 15_000` at `frontend/src/features/data/
  queries.ts:180-188`, moved server-side).
- Each tick: for every machine in the registry, ping `<url>/api/health`
  with `Authorization: Bearer <key>` — the same request the handler
  already builds inline today (`backend/internal/handler/
  machine.go:96-101`); factor it into a small `machineclient` helper so
  both the poller and the handler share one implementation.
- Results land in an in-memory map keyed by machine ID:
  `{status: "online"|"offline", latencyMs, lastCheckedAt}`. No DB/schema
  change — this is ephemeral state, same as other runtime-only state in
  this codebase; it resets cleanly on hub restart.
- `GET /api/machines/{id}/health` (`machine.go:90-116`) changes from
  always live to cache-first: serve the cached entry if present; on a
  cache miss (machine just added, or hub just started, before the first
  tick lands) fall back to one live check so there's no "unknown" gap.
  Response shape is unchanged (`{status, latencyMs?}`), so
  `frontend/src/lib/api.ts:654-656` and `useMachineHealth`
  (`queries.ts:180-188`) need no changes.

## Data flow

```
Hub/both process startup
  → self-register loop (unchanged code, self-pointed)   → local Machine row
  → health poller goroutine (new)                        → in-memory cache
       │ every 15s, pings every registered machine's /api/health
       ▼
GET /api/machines/{id}/health  ── cache hit ──→ cached {status, latencyMs}
                                ── cache miss ─→ one live check (unchanged path)
```

## Error handling

- `--role both` without `--key` → fatal at startup (same style as the
  existing `--role runtime` requires `--key` check).
- Self-registration-to-self failure (listener not up yet, transient) →
  logged, retried on the loop's existing interval, never fatal — identical
  to today's runtime→hub behavior.
- Desktop "Connect to a hub" with an unreachable URL → native webview
  navigation failure; a "change hub" affordance sits behind that, no new
  error-handling machinery needed.
- Hub polling: a failed ping writes `{status: "offline"}` into the cache
  (already today's designed-normal response for an unreachable machine,
  per the comment at `machine.go:87-89`) — never crashes the poller loop;
  one unreachable machine cannot stall others.

## Testing

- `--role both`: manual verification matching the existing pattern used
  for self-registration — start a process with `--role both --key ...`,
  curl its own `GET /api/machines` to confirm the self-entry appears. No
  new automated target, consistent with `main.go` wiring not being
  unit-tested elsewhere in this codebase.
- Hub polling: unit test the poller against `httptest.Server`-backed fake
  machines (online, offline, timeout cases), and that the health handler
  serves cached values without a live round trip once warm — same style as
  the existing `machineclient.SelfRegister` tests.
- Desktop remote-hub mode: manual/E2E smoke only (Rust stays thin enough
  that only pure helpers get unit tests, per the sidecar design's existing
  precedent) — launch, choose "Connect to a hub," confirm the SPA loads and
  login succeeds against a real hub.
- Existing WS compression/mobile regression tests, key-auth tests, and
  self-registration tests must keep passing unchanged.

## Sub-projects (build order)

1. **Backend:** `--role both` flag handling + self-register-to-self wiring
   in `main.go`; extract the health-ping call into `machineclient`; hub
   polling goroutine + in-memory cache; cache-first `GET /api/machines/
   {id}/health`.
2. **Tauri:** first-run choice screen (local sidecar path unchanged);
   "Connect to a hub" navigation path; persisted choice + "change hub"
   action.

Each sub-project gets its own implementation plan; backend first, since the
desktop change to "host locally" depends on `--role both` existing.

## Out of scope

- Public-internet exposure, new TLS termination, or auth hardening for the
  hub — networking model stays tailnet-only, unchanged from the original
  design's decision #8.
- Persisting machine health history or exposing it beyond the current
  single cached value per machine.
- Multi-hub sync/replication.
- Any change to terminal WS framing/compression behavior.
- Reducing or changing the frontend's own 15s `refetchInterval` — it keeps
  polling the (now much cheaper) endpoint exactly as today.
- A shared-credential/one-click-login path for "Connect to a hub" (e.g. a
  bearer key carried in the URL like the sidecar's ephemeral-key flow) —
  v1 uses the existing web login (session cookie) unchanged.
