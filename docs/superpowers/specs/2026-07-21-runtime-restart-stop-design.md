# Runtime Restart/Stop — Design

**Date:** 2026-07-21
**Status:** Approved (brainstorming complete)

## Goal

The Runtimes page (`MachinesModule.tsx`) lets an operator add, edit, and
delete registered machines, but has no way to control the machine's actual
*process* — if a runtime needs a restart (picked up a config change, is
stuck) or needs to be taken offline, the operator has to go do that by hand
on that machine. This project adds Restart and Stop controls to the
Runtimes page.

## Decisions (from brainstorming)

1. **True self-restart, not "stop and hope something brings it back."** A
   remote runtime is normally a bare `devdeck-server --role runtime ...`
   process with no supervisor (the copy-paste command from Add Runtime).
   Restart means the process spawns a fresh copy of itself (same
   executable, same args) and exits — it comes back on its own, no
   external supervisor required.
2. **The local machine gets Restart too**, not just remote ones (departs
   from the existing Edit/Delete pattern, which is remote-only). The local
   row is always this exact hub process (loopback URL from
   `upsert_local_machine`'s self-registration), so "restart local" is a
   loopback HTTP call to itself.
3. **The local machine does not get Stop.** The Tauri desktop's respawn
   loop (`run_local_respawn_loop`) already auto-relaunches its sidecar on
   any exit — a "stop" that bounces back within a second isn't a coherent
   action, and building a real stop/start lifecycle (a "the operator
   intentionally stopped this" state, a Start button) is out of scope for
   this project.

## Architecture

Two new self-management endpoints on every DevDeck process, plus a
hub-level wrapper the frontend calls:

```
Runtime process (any role: hub/runtime/both)
  POST /api/self/restart
    unmanaged → spawn a detached copy of itself (same executable +
                same os.Args), then exit.
    --managed → just exit; whatever launched this process (Tauri) already
                auto-respawns it. No self-spawn — avoids a second,
                colliding respawn.
  POST /api/self/stop
    unmanaged → exit, stays down.
    --managed → refuse with 409: "this runtime is supervised by its
                desktop app and can't be stopped from here." Exiting would
                just get silently resurrected by the Tauri respawn loop,
                which is a worse UX than a clear error.

Hub
  POST /api/machines/{id}/restart
  POST /api/machines/{id}/stop
    Looks up the machine, calls its own /api/self/restart|stop over HTTP
    using the machine's stored key (same request shape as
    machineclient.Probe/CheckHealth). Same code path for the local row —
    its stored URL is its own http://127.0.0.1:<port>, so this is a
    loopback call to itself. No isLocal branching on the wire.
    Stop returns 400 up front if the target machine isLocal (defense in
    depth — the frontend also never shows a Stop button for it).

Frontend (Runtimes page)
  Restart button on every row. Stop button on non-local rows only. Both
  go through one confirm dialog, then POST /api/machines/{id}/restart|stop.
```

**`--managed`** is a new boolean flag (`DEVDECK_MANAGED` env var) the Tauri
desktop always passes when it spawns a sidecar — the local hub
(`sidecar_args`) and its background remote-mode runtime (`runtime_args`)
both get it. It tells that process "something else already owns your
respawn lifecycle." This is what makes Restart safe for the local row
(no second respawn loop racing Tauri's own) and what makes Stop fail
cleanly instead of silently un-stopping itself a moment later — this
matters beyond just the local row: a Tauri desktop registered as someone
else's *remote* runtime shows up as an ordinary (non-local) row on *that*
hub's Runtimes page, and would hit the same self-resurrection problem on
Stop without this flag.

## Components

- **`backend/internal/handler/self.go`** (new) — `SelfHandler{managed
  bool}` with `PostRestart`/`PostStop`. The actual "spawn a copy of
  myself" and "exit the process" calls sit behind swappable package-level
  vars (same seam pattern as `detect.go`'s `shellPathDirs`), so tests can
  assert what *would* happen without really exec'ing a child or exiting
  the test binary. Platform split (`self_unix.go` / `self_windows.go`) for
  detaching the spawned child from the parent's process group/session so
  it survives the parent exiting.
- **`backend/cmd/server/main.go`** — new `--managed` /
  `DEVDECK_MANAGED` flag (`envBool`, default false), passed into
  `handler.NewSelfHandler`; register `POST /api/self/restart` and
  `POST /api/self/stop` for every role (hub/runtime/both) — same
  unauthenticated-by-default-false, wrapped-by-the-usual-auth-middleware
  treatment as every other `/api` route.
- **`backend/internal/machineclient`** — `Restart(ctx, m) error`,
  `Stop(ctx, m) error`, same request shape (`Authorization: Bearer
  m.Key`, short timeout) as the existing `Probe`/`CheckHealth`.
- **`backend/internal/handler/machine.go`** — `PostMachineRestart` /
  `PostMachineStop` on `MachineHandler`, registered at `POST
  /api/machines/{id}/restart` and `POST /api/machines/{id}/stop`.
  `PostMachineStop` 400s if the target machine's `IsLocal` is true.
- **`frontend/src-tauri/src/sidecar.rs`** — `sidecar_args()` and
  `runtime_args()` both append `--managed` to the child's argv.
- **Frontend**:
  - `restartMachine(id)` / `stopMachine(id)` in `lib/api.ts`.
  - `useRestartMachine()` / `useStopMachine()` in `features/data/queries.ts`
    — on success, invalidate `qk.machines` and `qk.machineHealth(id)`.
  - New `ConfirmMachineActionDialog` component (standalone, mirrors
    `DeleteFilesDialog`'s pattern rather than extending the delete-specific
    `ConfirmDeleteDialog`) — takes an `action: 'restart' | 'stop'` prop,
    different body copy and button label per action, same dark dialog
    chrome. New store slice (`confirmMachineAction` /
    `askMachineAction(action, id, name)` / `cancelMachineAction`) mirrors
    `confirmDelete`/`askDelete`'s shape.
  - `MachinesModule.tsx`'s `MachineRow` — two new icon buttons
    (RotateCw for restart, Square/Power for stop) next to the existing
    Edit/Delete pair; Stop only renders when `!machine.isLocal`.

## Data flow

1. Operator clicks Restart or Stop on a row → `askMachineAction` opens the
   confirm dialog with action-specific copy.
2. Confirm → `useRestartMachine`/`useStopMachine` mutation fires `POST
   /api/machines/{id}/restart|stop`.
3. Hub loads the machine, calls its `/api/self/restart|stop` with the
   machine's key. That call always completes (the target responds 200
   *before* it exits/respawns), so the hub's own response is never blocked
   on the target actually coming back up.
4. Hub relays success/failure to the frontend. Success → toast, close
   dialog, invalidate `qk.machines` + that machine's health query. Failure
   (unreachable, wrong key, 409-managed-stop, 400-local-stop) → toast with
   the real error message, dialog stays open so the operator can retry or
   cancel.
5. The restarted/stopped machine shows through the existing 15s health
   poll (`useMachineHealth`) — briefly "offline," then "online" again once
   the fresh process answers `/api/health`. No new polling logic needed.

## Error handling

- Rust: no new failure surface — `--managed` is just another static arg
  in `sidecar_args`/`runtime_args`, same as `--enable-tailscale-serve`.
- Go self-handler: `PostRestart` on an unmanaged process that fails to
  resolve its own executable path or fails to spawn the replacement
  returns 500 with the real error *without* exiting — better to stay up
  and report the failure than exit into nothing. `PostStop` always
  succeeds once past the managed check (nothing to fail).
- Go machine handler: `machineclient.Restart/Stop` failures (network,
  non-200, 409, 400) surface verbatim as the hub's own error response,
  same as every other machine-proxying path in this handler.
- Frontend: matches the existing mutation error pattern throughout
  `queries.ts`/`ConfirmDeleteDialog.tsx` — `err instanceof Error ?
  err.message : 'fallback'` in a toast.

## Testing

- Go: table tests on `SelfHandler` (managed × unmanaged, restart × stop)
  against the swappable spawn/exit seam — assert spawn-attempted/not and
  the right status code/body, no real process control in the test binary.
  `machineclient_test.go`: `Restart`/`Stop` against `httptest.Server`,
  mirroring the existing `Probe` test. `machine_test.go`: `MachineHandler`
  restart/stop routes, including the isLocal-stop-400 case.
- Rust: extend `sidecar.rs`'s `args_carry_the_desktop_contract`-style
  tests to assert `--managed` is present in both `sidecar_args` and
  `runtime_args` output.
- Frontend: no new component tests — matches this codebase's existing
  convention for this UI layer (no covering tests on `MachinesModule.tsx`,
  `MachineDialog.tsx`, or `ConfirmDeleteDialog.tsx` today).
- Manual: `make dev-tauri-full`, restart the local row from the Runtimes
  page, confirm the UI briefly shows offline then online again; register a
  second real (or scripted) runtime process and exercise restart/stop
  against it end to end.

## Out of scope

- A real stop/start lifecycle for the local machine (see Decision 3).
- Any UI indication that a specific remote machine happens to be
  `--managed` (e.g. graying out its Stop button pre-emptively) — the
  409 error from an actual click is sufficient; not worth new API surface
  to predict it.
- Restarting/stopping multiple machines at once (bulk actions).
- Any change to how machines are added, edited, or deleted.
