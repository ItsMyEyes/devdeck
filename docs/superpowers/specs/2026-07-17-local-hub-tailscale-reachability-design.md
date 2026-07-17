# Local-Hub Tailscale Reachability — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorming complete)

## Goal

Today, the Tauri desktop app's "Host locally" hub mode makes the Machines →
Add-runtime dialog show a command that can never work. `MachineDialog.tsx`
builds `--hub-url` from `window.location.origin`, but "Host locally" always
navigates the window to `http://127.0.0.1:<port>`
(`frontend/src-tauri/src/lib.rs:launch_once`) — a loopback address no other
machine can reach — and the local-hub sidecar never passes
`--enable-tailscale-serve` (`frontend/src-tauri/src/sidecar.rs:sidecar_args`),
so the port isn't exposed on the tailnet even if the URL were cosmetically
fixed. This is a note captured in `later.md`: "machine dialog
(`--hub-url ${hubUrl} --hub-key <key>`): hub-url should come from tailscale
serve, so desktop/hub needs tailscale installed — if not, show install/join
UI instead of raw args."

This project makes "Host locally" hubs actually reachable by remote
runtimes when Tailscale is available, and gives the operator clear,
non-blocking guidance in the dialog itself when it isn't.

## Decisions (from brainstorming)

1. **Non-blocking:** "Host locally" always starts normally, whether or not
   Tailscale is ready. A missing/unready Tailscale only affects what the
   Add-runtime dialog can offer — never local-only usage (worktrees,
   terminals, etc.). Matches the existing precedent in
   `2026-07-16-desktop-remote-runtime-self-registration-design.md` (missing
   Tailscale there is a warning, never fatal).
2. **No auto-install:** the dialog's Tailscale prompts are instructions and
   an open-link button only (e.g. `tailscale.com/download`, or guidance to
   sign in with the same account used on runtime machines). No scripted
   install, matching the existing "out of scope" precedent from the same
   design.
3. **Surfaced inline in `MachineDialog`:** when Tailscale isn't ready, the
   dialog swaps its content in place — no separate menu warning, no broken
   loopback command shown alongside the prompt.
4. **Readiness lives behind a new Go endpoint, not Tauri IPC:** `MachineDialog`
   queries a plain `/api/tailscale-status` HTTP endpoint rather than a Tauri
   `invoke()` bridge. This works identically for the desktop-hosted hub and
   any self-hosted hub deployment (the endpoint just reports the state of
   whatever machine the hub process itself is running on), and needs zero
   `useIsTauri()`-style branching in the frontend.
5. **Three readiness states**, each with distinct guidance copy:
   `not_installed`, `not_ready` (installed but not logged in / not running),
   `serve_disabled` (Tailscale itself is fine, but this hub process wasn't
   launched with `--enable-tailscale-serve` — needs a restart to pick it up).

## Architecture

Two independent pieces: a Rust-side spawn-time gate, and a Go-side status
endpoint the frontend polls on demand.

```
Rust (frontend/src-tauri, "Host locally" launch)
  launch_once
    └─ tailscale::public_url()  (existing function, reused as-is)
         Ok(_)  → sidecar_args(..., enable_tailscale_serve: true)
         Err(_) → sidecar_args(..., enable_tailscale_serve: false)
                   (today's behavior, unchanged)

Go (backend/cmd/server/main.go, any role)
  *tailscaleServe (existing flag, now also threaded into a new handler)
    └─ GET /api/tailscale-status
         !tailscaleServe                        → {ready:false, reason:"serve_disabled"}
         tailscaleServe && tailscale missing     → {ready:false, reason:"not_installed"}
         tailscaleServe && status lookup fails   → {ready:false, reason:"not_ready"}
         tailscaleServe && status lookup OK      → {ready:true, url:"https://<dnsname>"}

Frontend (MachineDialog.tsx, on dialog open)
  window.location.hostname loopback?
    no  → unchanged: use window.location.origin (today's behavior)
    yes → GET /api/tailscale-status
            ready        → runtime command using returned url (today's UI)
            not_installed→ "Install Tailscale" prompt + download link
            not_ready    → "Sign in to Tailscale" prompt (same account as runtimes)
            serve_disabled → "Restart Loom to expose this hub" prompt
```

### Components

**1. `frontend/src-tauri/src/sidecar.rs` (extend)** — `sidecar_args` gains an
`enable_tailscale_serve: bool` parameter; when true, appends
`--enable-tailscale-serve` to the local-hub args (same flag/spelling the
runtime-mode args already use).

**2. `frontend/src-tauri/src/lib.rs` (extend)** — `launch_once` calls
`tailscale::public_url().await` before building `sidecar_args`, using
`.is_ok()` as the new bool argument. No behavior change to `tailscale.rs`
itself; it's reused verbatim.

**3. `backend/internal/handler/tailscale_status.go` (new)** — mirrors
`health.go`'s shape: no store/service dependency, just
`writeJSON(w, http.StatusOK, response)`. Constructed with the `tailscaleServe
bool` captured from the existing `*tailscaleServe` flag in `main.go`. Shells
out to `tailscale status --self --json` (same command `tailscale.rs` already
runs on the Rust side, and the same command `startTailscaleServe`'s sibling
code already invokes via `exec.LookPath("tailscale")`), parses `.Self.DNSName`
the same way, trims the trailing dot, and returns `https://<dnsname>`.

**4. `backend/cmd/server/main.go` (extend)** — construct the new handler next
to `healthH`/`whoamiH` (`main.go:219-220`) and register
`mux.HandleFunc("GET /api/tailscale-status", tsH.ServeHTTP)` alongside them
(`main.go:287-288`). Falls under the same blanket `authMW(mux)` wrapping as
every other `/api` route (`main.go:450-457`) — no special-casing needed.

**5. `frontend/src/features/machines/MachineDialog.tsx` (extend)** — on
dialog open (non-edit, non-paste mode), if `window.location.hostname` is
`127.0.0.1` or `localhost`, fetch `/api/tailscale-status` and branch the
existing "Runtime command" section into one of the four states above. Not
loopback → today's `runtimeCommand()` path, byte-for-byte unchanged.

## Data flow

1. Operator picks "Host locally" (first run or restart). Rust checks
   Tailscale once, before spawning; the resulting flag is baked into that
   session's sidecar args and doesn't change until the app restarts.
2. Operator opens Machines → Add runtime. `MachineDialog` detects it's
   looking at a loopback origin and asks the running hub, live, "are you
   actually reachable right now."
3. The hub's answer can lag the Rust-side decision by one restart (e.g.
   Tailscale installed after the app already launched) — that's exactly what
   `serve_disabled` communicates, with the fix being "restart Loom," mirroring
   the existing "Change Hub…" restart-to-apply pattern.

## Error handling

- Rust: `tailscale::public_url()` failing is not an error condition for hub
  startup — it just means the flag is omitted. No new failure surface.
- Go: the status endpoint never fails the request itself; every outcome
  (including "not installed") is a `200` with a structured body, matching
  how the frontend needs to render a specific prompt per state rather than a
  generic error toast.
- Frontend: a network/parse failure calling `/api/tailscale-status` (e.g. the
  hub's `/api` briefly unreachable) falls back to the existing plain
  `runtimeCommand()` behavior rather than blocking the dialog — worst case,
  the operator sees the same non-working command they'd see today.

## Testing

- Rust: extend `sidecar.rs`'s `args_carry_the_desktop_contract`-style test
  coverage to assert `--enable-tailscale-serve` is present/absent based on
  the new bool.
- Go: new `tailscale_status_test.go`. `not_installed` is testable by
  manipulating `PATH` in-test (no existing command-runner mock seam in this
  codebase — `tools.go`/`worktree_test.go` shell out to real binaries the
  same way). `ready`/`not_ready` against a real logged-in Tailscale are
  exercised manually only, matching the existing precedent that
  `startTailscaleServe` itself ships with no automated tests.
- Manual/E2E: `make dev-tauri-full` in "Host locally" mode, once without
  Tailscale (confirm `not_installed` prompt, confirm local-only usage still
  works) and once with Tailscale installed and joined (confirm `ready` after
  a restart, confirm a second real machine can self-register using the shown
  command).

## Out of scope

- Auto-installing Tailscale.
- Verifying the runtime machine ends up on the *same* tailnet as the hub —
  guidance text only ("sign in with the same account"), not programmatically
  checked.
- Any change to "Connect to remote hub" mode — `window.location.origin` there
  is already the operator-supplied real hub URL; this project only touches
  the loopback case.
- Changing `--enable-tailscale-serve`'s existing fatal-on-missing-binary
  behavior for explicit self-hosted/operator use
  (`2026-07-04-enable-tailscale-serve-design.md`) — unchanged; the Rust-side
  preflight exists specifically so the local-hub sidecar never passes the
  flag when it would be fatal.
- Detecting or recovering from the `tailscale serve` child process exiting
  *after* a successful launch (already logged non-fatally by
  `startTailscaleServe`; the status endpoint's live lookup will naturally
  start reporting `not_ready` once tailscaled/serve is actually down, without
  new state-tracking).
