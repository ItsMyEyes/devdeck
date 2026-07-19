# Tauri Desktop E2E Smoke Harness — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorming complete)

## Goal

Give `make dev-tauri-full` a scripted smoke test that exercises the real
local-hub-mode desktop flow (sidecar spawn → health check → machine
registration → clean process teardown) without needing a human to click
through the native window, while keeping the project's existing convention
of a manual visual check for the one thing that genuinely requires eyes on
the screen (does the hand-written `choose.html` render correctly).

## Background

Every prior desktop-shell spec in this repo
(`2026-07-13-tauri-desktop-sidecar-design.md`,
`2026-07-16-desktop-remote-runtime-self-registration-design.md`) scopes E2E
as "manual smoke test" — there is no tauri-driver/WebDriver harness anywhere
in the repo, and this design does not introduce one. Building real
WebDriver-driven native GUI automation (tauri-driver + safaridriver) would be
new, unmaintained infrastructure with no precedent here; it's explicitly out
of scope.

Investigating a real `make dev-tauri-full` run surfaced why it's flaky to use
for anything scripted: with `devUrl`/`beforeDevCommand` unset, `tauri dev`
doesn't just serve `frontendDist` statically — it runs its own built-in dev
server with hot-reload injection, which rewrites HTML files in place and
treats any touch to them (its own rewrite, or a concurrent edit from another
tool) as a signal to kill and fully recompile the app. That's inherent to
`tauri dev`'s dev-server mode and isn't worth patching around; the fix is to
not use `tauri dev` for scripted testing at all.

## Decisions

1. **Build once, don't watch.** The harness uses
   `tauri build --no-bundle --debug --config <e2e config>` to produce a
   plain `target/debug/app` binary — no file-watcher, no hot-reload
   injection, so the race that produced "asset not found: choose.html"
   cannot happen. `DEVDECK_TAURI_DEV_FULL=1` is set when the binary is launched
   (it's read at runtime in `lib.rs`'s `setup()`, not at build time), so the
   real hub-mode/sidecar/respawn flow still runs.
2. **A third, isolated Tauri config.** `frontend/src-tauri/tauri.e2e.conf.json`
   mirrors `tauri.dev-full.conf.json` (drops `devUrl`/`beforeDevCommand`) but
   uses its own `identifier` (`dev.kiyora.devdeck.e2e`) so smoke-test runs never
   collide with a developer's manual `dev-tauri-full` session or the real
   installed app's data (each identifier maps to its own app-data/app-log
   directory). It also overrides `beforeBuildCommand` to
   `cd .. && make sidecar-host` (host-triple only) instead of the base
   config's `make prepare-sidecar` (3-platform cross-compile), since a smoke
   test only ever runs on the host.
3. **Pre-seed `hub-mode.json` to skip the one unscriptable step.** The only
   part of this flow that genuinely requires a human click is the
   choose-hub-mode screen. The script writes `{"mode":"local"}` into the
   e2e identifier's app-data dir before launching, so `hubmode::load` finds
   a saved choice and `start()` goes straight to `run_local_respawn_loop` —
   sidecar spawn, health poll, machine upsert, window navigate — skipping
   `show_choose_screen` entirely. Verifying `choose.html` itself renders
   correctly stays a manual, one-glance check (see Testing below); it isn't
   covered by this script and that's an accepted trade-off, not a gap to
   close later.
4. **Scope: local hub mode only.** The remote-hub / Tailscale runtime
   self-registration path (`run_remote_runtime_loop`) is not covered by this
   pass. The same pre-seed-then-observe technique would generalize to it
   (seed a `Remote { url, key }` hub-mode instead), but it's a separate
   follow-on, not required here.

## Architecture

```
make e2e-tauri-smoke
  └─ frontend/src-tauri/scripts/e2e-smoke.sh
       1. reset app-data dir + app-log dir for identifier dev.kiyora.devdeck.e2e
       2. seed hub-mode.json = {"mode":"local"}
       3. tauri build --no-bundle --debug --config tauri.e2e.conf.json
            (runs beforeBuildCommand: make sidecar-host)
       4. DEVDECK_TAURI_DEV_FULL=1 target/debug/app &        (background)
       5. poll <app-log-dir>/sidecar.log for the
          "devdeck listening on http://127.0.0.1:<port>" line  → parse port
       6. poll GET http://127.0.0.1:<port>/api/health until 200
       7. poll <app-data-dir>/local-machine-id until it contains
          an id matching ^m-[0-9a-f]+$
             (hubapi::upsert_local_machine only writes this file after a
              successful POST /api/machines — see hubapi.rs:67-104)
       8. kill the app process; confirm the devdeck-server child
          (matched by process name devdeck-server-<host-triple>) also exits
          within a few seconds (no orphan — mirrors kill_sidecar's
          documented behavior in lib.rs)
       9. print a PASS/FAIL summary per step; exit 0 iff all steps passed
```

No key extraction is needed anywhere in the script: `/api/health` is a
public route by design (`RequireAuth` in `middleware.go` allowlists it), and
machine-registration success is observed indirectly via the
`local-machine-id` file rather than by authenticating against `/api/machines`
with the sidecar's per-launch ephemeral key.

## Components

- **`frontend/src-tauri/tauri.e2e.conf.json`** (new) — config overlay, see
  Decisions #2.
- **`frontend/src-tauri/scripts/e2e-smoke.sh`** (new) — the harness itself,
  bash (matches this repo's existing Makefile-driven, bash-first tooling
  convention; no new language/runtime dependency).
- **`Makefile`** — new `.PHONY` target `e2e-tauri-smoke` that runs the
  script. Not a dependency of `test`/`lint` (it needs a full Tauri/Cargo
  build and a real Go sidecar build, so it's opt-in, not part of the fast
  everyday loop).
- **`COMMANDS.md`** — documents the new target next to the existing
  `dev-tauri`/`dev-tauri-full` entries, including the one remaining manual
  step (visually confirm `choose.html` renders) that this script
  intentionally does not cover.

## Data locations

- App data: `~/Library/Application Support/dev.kiyora.devdeck.e2e/`
  (`hub-mode.json`, `devdeck.db`, `local-machine-id`) — macOS path; this harness
  targets macOS only for now (the project's dev machine), matching how
  `dev-tauri-full` itself has only been exercised on macOS so far.
- App logs: `~/Library/Logs/dev.kiyora.devdeck.e2e/sidecar.log`.
- Both directories are wiped at the start of every run for a clean first
  run each time (the harness always tests the "already chose local"
  fast-path deliberately, not the choose-screen path — see Decisions #3).

## Error handling

- Each step (binary built, listen line appeared, health check 200,
  machine-id file appeared, child process reaped after kill) is checked
  with its own bounded poll/timeout (mirroring `READY_TIMEOUT_SECS = 15` in
  `sidecar.rs`) and its own clear failure message naming which step failed
  and dumping the relevant log tail — no silent hangs.
- The script always attempts to kill the app process on exit (success,
  failure, or interrupt) via a trap, so a failed run doesn't leave an
  orphaned `target/debug/app` or `devdeck-server` process behind for the next
  run to collide with.

## Testing

- Running `make e2e-tauri-smoke` itself **is** the test — there's no
  separate test suite for a smoke-test script. Verify it once by hand:
  run it against a clean checkout, confirm all steps print PASS, then
  introduce a deliberate failure (e.g. temporarily break
  `upsert_local_machine`'s POST body) and confirm the script fails loudly
  at the right step rather than hanging or false-passing.
- Manual, outside this script: launch `make dev-tauri-full` (the normal
  developer-facing target, unaffected by this change) at least once and
  visually confirm the choose-hub-mode screen renders; this script
  deliberately does not replace that check.

## Out of scope

- Remote hub mode / Tailscale runtime self-registration path (Decisions #4).
- Any tauri-driver/WebDriver-based native GUI automation.
- Windows/Linux — macOS only for now.
- Wiring this into CI (no macOS Tauri/Cargo toolchain is set up there today;
  this is a local, opt-in developer smoke test).
