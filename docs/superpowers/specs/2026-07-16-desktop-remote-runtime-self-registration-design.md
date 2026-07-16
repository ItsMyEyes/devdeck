# Desktop Remote-Hub Runtime Self-Registration — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorming complete)

## Goal

Today, the Tauri desktop app's "Connect to a hub" mode
(`docs/superpowers/specs/2026-07-14-hub-runtime-dual-role-and-polling-design.md`,
sub-project 2) is purely passive: the operator types a hub URL, and the
window just navigates there and behaves like a browser tab against that
hub's existing session-cookie login. No sidecar is spawned, so the
desktop's own machine never appears in that remote hub's Machines registry
— the operator has to separately run the full bootstrap-installer flow on
that same machine to make it usable as a runtime.

This project closes that gap: changing the hub URL in the desktop app
should also make the desktop's own machine ("self machine") available on
that hub automatically, by spawning the bundled backend as a
`--role runtime` process in the background and letting it self-register
over Tailscale — reusing the runtime self-registration loop
(`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`)
and the `--enable-tailscale-serve` flag
(`docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md`) that
already exist on the backend. This is a note captured in `later.md`: "in
desktop apps, can settings hub its machine self or setting base url for
it."

No backend/Go changes are needed — every flag and loop this relies on
(`--hub-url`, `--hub-key`, `--public-url`, `--name`,
`machineclient.RunSelfRegisterLoop`, `--enable-tailscale-serve`) already
ships and works. This project is entirely new wiring in
`frontend/src-tauri/`.

## Decisions (from brainstorming)

1. **Core scope:** in remote-hub mode, the window still navigates to and
   browses the remote hub's UI exactly as today, but the desktop shell
   *also* spawns its bundled backend as a `--role runtime` in the
   background and self-registers it with that hub, so the operator's own
   machine shows up as a usable runtime there without any separate
   install step.
2. **Hub key input:** the "Connect to a hub" form gains a second required
   field, the hub's bearer key (the same value passed as `--key`/`LOOM_KEY`
   on that hub), submitted together with the URL. Self-registration's
   `POST`/`PATCH /api/machines` calls need `Authorization: Bearer
   <hub-key>` — the browser window's session-cookie login covers browsing
   only, not this machine-to-machine call.
3. **Missing Tailscale:** if the `tailscale` CLI is missing, not logged in,
   or the lookup otherwise fails, the runtime spawn is skipped entirely —
   logged clearly and surfaced as a small non-blocking warning (see
   "Failure surface" below). The window still navigates to and browses the
   remote hub exactly like today. No auto-install (unlike the bootstrap
   installer's script, which targets a bare unattended machine — the
   desktop app runs on the operator's own already-set-up computer).
4. **Settings UX:** no new live in-app Settings page. Editing the hub
   URL/key keeps today's existing flow: menu → "Change Hub…" → clears the
   saved choice → app restarts → the choose-a-mode screen reappears, now
   with both URL and key fields.

## Architecture

```
Tauri shell, HubMode::Remote { url, key }
  ├─ navigate_remote(url)                    (unchanged — window → remote hub SPA)
  └─ spawn_local_runtime(url, key)  (new, concurrent, non-blocking)
       1. tailscale status --self --json → DNSName → https://<dnsname>
          (failure → log + warning menu item, stop here)
       2. read-or-generate <data_dir>/runtime-key
       3. spawn loom-server:
            --role runtime --addr 127.0.0.1:0
            --key <persisted runtime key>
            --db <data_dir>/loom-runtime.db
            --env <data_dir>/.env
            --hub-url <url> --hub-key <key>
            --public-url https://<dnsname>
            --enable-tailscale-serve
            --name <hostname>
       4. wait for the "loom listening on" line + one health check
          (reuses sidecar::parse_listen_port, hubapi::wait_healthy)
       5. on success: pump logs to <log_dir>/runtime-sidecar.log,
          monitor + respawn on crash (existing MAX_RESPAWNS pattern)
          on failure/timeout: log + warning menu item
  Backend (unchanged): --role runtime + --hub-url/--hub-key triggers
  machineclient.RunSelfRegisterLoop (main.go:501); --enable-tailscale-serve
  spawns `tailscale serve <port>` (main.go:495-571) so the advertised
  --public-url is actually reachable on the tailnet.
```

### Components

**1. `choose.html` (extend)** — remote-connect form gains a second input,
`#hub-key`, required alongside `#url` before the Connect button is
enabled. `invoke('choose_hub_mode', { mode: 'remote', url, key })`.

**2. `hubmode.rs` (extend)** — `HubMode::Remote` becomes
`Remote { url: String, key: String }`. `choose_hub_mode` command signature
gains `key: Option<String>`, validated required for the `"remote"` arm the
same way `url` already is.

**3. New Tailscale lookup helper** — shells out to
`tailscale status --self --json`, deserializes just `.Self.DNSName`, trims
the trailing dot, returns `https://<dnsname>`. Pure function, unit-testable
against captured JSON fixtures (no live Tailscale needed in tests, mirroring
how `sidecar.rs`'s helpers are tested against fixed strings today).

**4. Runtime sidecar spawn (extend `lib.rs`)** — `proceed_with_mode` for
`HubMode::Remote` calls `navigate_remote` (unchanged) and, in a separate
`tauri::async_runtime::spawn`, a new `run_remote_runtime_loop` mirroring
`run_local_respawn_loop`'s shape: build args (persisted key + derived
public URL + operator-supplied url/key/name), spawn, wait-healthy, monitor,
respawn up to `MAX_RESPAWNS`, log to `runtime-sidecar.log` instead of
`sidecar.log`. A second managed state slot, `RuntimeServerProc(Mutex<Option
<CommandChild>>)`, parallel to the existing `ServerProc`, holds this
child; `kill_sidecar` is extended to kill whichever slot is populated (in
practice only one of the two is ever populated per launch, since local and
remote modes are mutually exclusive).

**5. Failure surface** — on Tailscale-lookup failure or a runtime that
never becomes healthy: log to `runtime-sidecar.log`, and swap the existing
"Change Hub…" menu item for a "⚠ Runtime not registered" item. Clicking it
navigates the window to a new bundled `runtime-warning.html` (same
tauri://localhost bundled-page pattern as `error.html`) showing the reason
and log path, with a button that returns the window to the remote hub URL.
Browsing is never delayed or blocked waiting on this — the Tailscale
lookup + spawn + health-wait run fully in the background.

## Data locations (desktop, remote mode)

- Runtime key: `<appDataDir>/runtime-key` (persisted, unlike the ephemeral
  per-launch key used by "Host locally" — self-registration needs a stable
  key across restarts to keep matching the same machine row by URL).
- Database: `<appDataDir>/loom-runtime.db` — separate from
  `<appDataDir>/loom.db` (the "Host locally" hub's db) so switching modes
  on the same install never collides.
- Sidecar logs: `<appLogDir>/runtime-sidecar.log`, same truncate-at-5MB
  behavior as the existing `sidecar.log`.

## Error handling

- Missing/unauthenticated Tailscale CLI → runtime spawn skipped, logged,
  warning menu item shown; remote browsing unaffected.
- Runtime process crashes after a successful launch → respawned up to
  `MAX_RESPAWNS` (persisted key + derived public URL are stable across
  respawns, so self-registration re-upserts the same row); beyond that,
  logged + warning menu item, remote browsing unaffected.
- Hub unreachable, or hub key wrong → same as today's backend behavior:
  `machineclient.RunSelfRegisterLoop` logs and retries on its own interval
  indefinitely; never fatal to the runtime process itself.
- App quit → both the runtime sidecar (if running) and any local-hub
  sidecar are killed, matching the existing `kill_sidecar` / signal-handler
  behavior.

## Testing

- Rust unit tests: the Tailscale DNSName-parsing helper against fixture
  JSON (present, missing `Self`, trailing-dot stripping); `HubMode::Remote`
  serialization round-trip with the new `key` field (extending
  `hubmode.rs`'s existing test module); runtime sidecar arg construction
  (mirrors `sidecar.rs`'s `args_carry_the_desktop_contract` test).
- No backend/Go changes — existing self-registration and
  `--enable-tailscale-serve` tests are unaffected.
- E2E smoke (manual): on a machine with Tailscale installed and joined,
  connect the desktop app to a real remote hub with URL + key, confirm the
  machine appears in that hub's Machines page shortly after, confirm quit
  leaves no `loom-server` runtime process behind; separately, on a machine
  without Tailscale, confirm remote browsing still works and the warning
  menu item appears.

## Out of scope

- Auto-installing Tailscale (unlike the bootstrap installer script).
- Unregistering/removing the machine from a previous hub when switching
  hubs — matches the existing accepted limitation in the runtime
  self-registration and bootstrap-installer designs (operator cleans up
  stale entries manually via the Machines UI).
- A live in-app Settings page — editing hub URL/key still goes through
  "Change Hub…" + restart.
- Any backend/Go changes.
- Making "Host locally" mode also self-register as a remote-reachable
  runtime — out of scope per the 2026-07-14 design's own note (the sidecar
  binds an ephemeral `127.0.0.1:0` port every launch, incompatible with
  stable self-registration by URL).
