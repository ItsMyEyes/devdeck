# Runtime Bootstrap Installer — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorming complete)

## Goal

Today, deploying a new `--role runtime` machine requires the operator to
manually install Tailscale, join the tailnet, figure out the machine's
MagicDNS name, and hand-assemble a long flag/env list
(`--role runtime --key ... --hub-url ... --hub-key ... --public-url ...
--name ... --enable-tailscale-serve`) before starting the binary, and there
is no way to actually add that machine to the hub's registry from the UI —
the Add-machine dialog only shows a generated self-register command; the
existing `POST /api/machines` create path is never called from the
frontend today.

This project packages the already-existing runtime binary together with an
install script that runs a preflight checklist, joins Tailscale
automatically, starts the runtime as a background service, and hands the
operator a ready-to-paste connection string — plus a new "paste connection
string" path in the hub's Add-machine dialog that verifies the machine is
actually reachable (and the key actually correct) before registering it.
So adding a machine becomes: copy one folder, fill in a handful of values
once, run one command, paste one line into the hub.

Almost everything this needs already exists and works today: `--role`,
`--key` (`LOOM_KEY`), `--hub-url` (`LOOM_HUB_URL`), `--hub-key`
(`LOOM_HUB_KEY`), `--public-url` (`LOOM_PUBLIC_URL`), `--name`
(`LOOM_MACHINE_NAME`), `--enable-tailscale-serve`
(`LOOM_TAILSCALE_SERVE`), and `POST /api/machines` — see
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md` and
`docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md`. This
project is a packaging/bootstrap layer on top of those, plus one small,
targeted backend change (a reachability+auth check on machine creation) and
one small frontend addition (wiring the already-existing but unused
`useCreateMachine` hook to a new paste-based UI).

## Decisions (from brainstorming)

1. **Target platforms:** macOS, Linux, and Windows (amd64 + arm64 where the
   existing `make portable-all` matrix already produces a binary).
2. **Tailscale auth:** a single reusable Tailscale auth key, generated once
   by the operator from the Tailscale admin console, baked into the env
   template and reused across every machine — `tailscale up
   --authkey=$TS_AUTHKEY` runs non-interactively, no per-machine login flow.
3. **Checklist behavior:** auto-install missing dependencies (chiefly
   Tailscale) rather than just detecting and reporting them, matching the
   goal that the operator does no manual setup on the target machine.
4. **Distribution:** a self-contained bundle (zip/tar) that the operator
   copies to the new machine by whatever means (AirDrop, scp, USB) — not a
   `curl | sh` script that downloads from GitHub. The release repo is
   private, so a download-based installer would need a GitHub token present
   on every new machine; a copied bundle needs nothing but what's already in
   the folder.
5. **Persistence:** the install script registers the runtime as a
   background service (launchd / systemd-user / Windows Scheduled Task) so
   it survives reboots, rather than just launching it in the foreground.
6. **Runtime key uniqueness:** each machine gets its own randomly generated
   `LOOM_KEY`, created by the install script on first run and persisted
   locally — not a single static key shared by every runtime. Slightly more
   setup than a shared key, but keeps one compromised machine's key from
   exposing every other runtime.
7. **Public URL has no port:** since `--enable-tailscale-serve` fronts the
   app with `tailscale serve`, which publishes over HTTPS on the tailnet's
   implicit port 443, the externally-reachable URL is `https://<dnsname>`
   — **not** `https://<dnsname>:<local-port>`. The local port
   (`--addr`'s port) is only what `tailscale serve` proxies *to*; it never
   appears in the advertised/pasted URL.
8. **Two connection methods coexist:** self-registration
   (`LOOM_HUB_URL`/`LOOM_HUB_KEY` in `runtime.env`, opt-in, unchanged from
   the existing design) and a new manual "paste connection string" path
   stay both available side by side. Self-registration requires
   distributing the hub's own key to every runtime's env file; the paste
   path avoids that entirely (the operator never puts the hub key on a
   runtime machine) at the cost of one manual paste per machine. The
   install script always generates the connection string regardless of
   whether self-registration is configured, so it's available as a
   fallback either way.
9. **Connection-string format:** `name|url|key` (pipe-delimited), not
   colon-delimited — the URL itself contains colons (`https://…`), so `:`
   can't safely separate fields.
10. **Reachability check is authenticated, not just a ping:** pasting a
    connection string into the hub must confirm both that the machine is
    reachable *and* that the key is correct, so a typo'd or stale key fails
    immediately with a clear error rather than silently registering a
    broken machine. Since `GET /api/health` is deliberately exempt from the
    runtime's key middleware (see `backend/internal/handler/keyauth.go`),
    the check must hit a different, authenticated route — plain
    reachability alone would pass even with a wrong key.
11. **Already-running detection:** the install script checks whether its
    background service is already registered/running before touching it,
    so re-running the installer (e.g. after editing `runtime.env`) updates
    the existing service in place instead of erroring or double-registering.

## Architecture

```
Bundle (per OS/arch, e.g. loom-runtime-darwin-arm64.zip)
├── loom                     (prebuilt binary, from make portable-all)
├── install.sh / install.ps1 (checklist + service registration)
├── uninstall.sh / uninstall.ps1
├── runtime.env.example      (operator fills in once, renames to runtime.env)
└── README.md                (one-time setup instructions)
```

The operator downloads the bundle for their platform once (with a GitHub
token, same as today's release download), fills in `runtime.env`, and from
then on copies that same folder — env included — to every new machine. Only
`install.sh`/`install.ps1` needs to run there.

### `runtime.env.example`

```
TS_AUTHKEY=<reusable Tailscale auth key from the admin console>
# LOOM_MACHINE_NAME=   (optional; defaults to OS hostname)
# LOOM_ADDR=           (optional; defaults to 127.0.0.1:8989)

# Optional: enables automatic self-registration on startup. Leave both
# blank to skip self-registration and connect this machine manually
# instead, by pasting copy-this.md's contents into the hub's Add Runtime
# dialog once the installer finishes.
# LOOM_HUB_URL=
# LOOM_HUB_KEY=
```

`LOOM_KEY` is deliberately not in this template — see Decision 6.
`TS_AUTHKEY` is the only value strictly required; the hub fields are opt-in.

### Install script flow (`install.sh` macOS/Linux, `install.ps1` Windows)

1. **Preflight** — confirm `runtime.env` exists next to the script and that
   `TS_AUTHKEY` is present and isn't still the placeholder text. If exactly
   one of `LOOM_HUB_URL`/`LOOM_HUB_KEY` is set (not both), fail fast — a
   partial self-registration config is a misconfiguration, not a valid
   "disabled" state.
2. **Tailscale checklist:**
   - Detect the `tailscale` binary on `PATH`. If missing, auto-install:
     - macOS: `brew install tailscale` if Homebrew is present, else the
       official install script.
     - Linux: the official `https://tailscale.com/install.sh` (detects
       apt/yum/pacman itself).
     - Windows: `winget install Tailscale.Tailscale`.
   - Check join state via `tailscale status`. If not authenticated, run
     `tailscale up --authkey=$TS_AUTHKEY --hostname=<machine-name>
     --ssh=false` non-interactively.
3. **Derive the public URL** — `tailscale status --self --json`, read
   `.Self.DNSName` (strip the trailing dot), build
   `https://<dnsname>` (see Decision 7 — no port suffix).
4. **Generate & persist `LOOM_KEY`** — if a local key file
   (`./runtime.key`, `chmod 600`) doesn't already exist, generate 32 random
   bytes hex-encoded and write it; if it exists (re-run), reuse it. This
   makes re-running the installer idempotent, and means `copy-this.md`
   stays stable across re-runs.
5. **Detect an already-running service** (Decision 11) — check whether the
   launchd label / systemd unit / scheduled task from a prior run exists
   and is active. If so, stop it cleanly before re-registering, so a
   changed `runtime.env` or regenerated key actually takes effect; report
   "✓ found an existing installation, updating it in place" rather than
   erroring on "already exists".
6. **Register as a background service**, passing all config as environment
   variables (`LOOM_ROLE=runtime`, `LOOM_KEY`, optional `LOOM_HUB_URL` /
   `LOOM_HUB_KEY`, `LOOM_PUBLIC_URL`, `LOOM_MACHINE_NAME`,
   `LOOM_TAILSCALE_SERVE=true`) so the bundled binary needs no CLI flags at
   all:
   - **macOS:** a `launchd` `LaunchAgent` plist under
     `~/Library/LaunchAgents/`, `RunAtLoad` + `KeepAlive`, environment
     variables embedded in the plist's `EnvironmentVariables` dict (parsed
     from `runtime.env` + the generated key), loaded via `launchctl
     bootstrap`.
   - **Linux:** a `systemd --user` unit
     (`~/.config/systemd/user/loom-runtime.service`) with
     `EnvironmentFile=` pointing at a merged env file, enabled via
     `systemctl --user enable --now`.
   - **Windows:** a Scheduled Task registered to run at user logon
     (`schtasks /create` / `Register-ScheduledTask`), wrapping the binary
     with the environment variables set in the task action. This is not a
     true Windows Service (SCM) — see Out of scope.
7. **Generate `copy-this.md`** in the bundle folder:
   ```markdown
   # Connect this runtime to your hub

   Paste the line below into the hub's **Add Runtime** dialog →
   **Paste connection string**:

       <machine-name>|https://<dnsname>|<generated-key>
   ```
   Regenerated on every run with the current name/URL/key, so it's always
   accurate even after a re-run changes any of them.
8. **Print a checklist summary** as each step completes (✓ Tailscale
   installed / ✓ joined tailnet as `<dnsname>` / ✓ runtime key ready / ✓
   background service registered / ✓ `copy-this.md` written), ending with:
   if self-registration is configured, a note that the hub should show
   this machine shortly on its own; if not, a reminder to paste
   `copy-this.md`'s contents into the hub UI to connect it.

### `--dry-run` mode

Both scripts accept a `--dry-run` flag that runs the preflight and prints
every action it *would* take (installs, `tailscale up`, service
registration, generated `copy-this.md` content) without executing any of
them. This is the only way to exercise the script's logic without mutating
a real machine (see Testing).

### `uninstall.sh` / `uninstall.ps1`

Stops and removes the background service (`launchctl bootout` /
`systemctl --user disable --now` + unit file removal / `schtasks /delete`).
Does not touch Tailscale's join state or the hub's machine registry entry —
those are left for the operator to clean up explicitly (removing a machine
from the hub is already a UI action; this script only undoes what it
registered).

### CI / Makefile changes

- New Makefile target, e.g. `runtime-bundle-all`, that — for each
  `os/arch` pair `make portable-all` already produces — assembles
  `dist/bundles/loom-runtime-<os>-<arch>.zip` (Windows) or `.tar.gz`
  (macOS/Linux) containing the binary plus the script/template/README files
  above.
- `.github/workflows/release.yml`: a new step in `build-backend` (after
  `make portable-all`) runs `make runtime-bundle-all` and uploads
  `dist/bundles/*` alongside the existing `backend-binaries` artifact, so
  bundles ship as release assets on every tagged release.

### Hub UI: "paste connection string" (new)

`frontend/src/features/machines/MachineDialog.tsx`'s Add mode currently
only shows a Name input and a generated self-register shell command (no
submit button — the existing `useCreateMachine` hook from
`frontend/src/features/data/queries.ts` is wired up but never called
anywhere). This project adds a second option to that same dialog:

- A "paste connection string" textarea. The operator pastes the
  `name|url|key` line from `copy-this.md`.
- On submit, the frontend parses the three pipe-delimited fields client-side
  and calls `useCreateMachine` → `POST /api/machines` (already implemented,
  just newly invoked) with `{name, url, key}`.
- The existing self-register-command option remains, unchanged, as the
  other choice in the same dialog — the operator picks whichever matches
  how they configured `runtime.env`.
- Malformed paste (wrong number of fields, non-`https://` URL) is rejected
  client-side before submit, reusing the dialog's existing validation
  styling.

### Backend: reachability + auth check on machine creation

`backend/internal/handler/machine.go`'s `PostMachine` gains a pre-create
check: before calling `st.CreateMachine`, it makes an HTTPS request to the
submitted `url` against a route that *is* gated by the runtime's key
middleware (not `GET /api/health`, which is deliberately open — see
Decision 10), using `Authorization: Bearer <key>`, with a short timeout
(e.g. 5s):

- Success (200) → proceed to create the machine as today.
- Network/TLS/timeout failure → reject with a distinct "machine
  unreachable" error (`{"error":"..."}`, existing envelope).
- 401 from that route → reject with a distinct "key rejected by machine"
  error, so a typo'd key is obviously not a network problem.

This check applies uniformly to every `POST /api/machines` call, including
the existing self-registration path (the runtime calling this endpoint
about itself) — which benefits too: a misconfigured `--public-url` on the
runtime side now fails loudly against the hub instead of silently creating
an unreachable registry entry.

## Error handling

- Missing/placeholder `runtime.env` values, or a partial
  `LOOM_HUB_URL`/`LOOM_HUB_KEY` pair → fail fast, name the exact variable,
  exit non-zero before touching Tailscale or the service manager.
- Invalid or expired `TS_AUTHKEY` → surfaced verbatim from `tailscale up`'s
  own error output; script exits non-zero rather than retrying silently
  (the operator needs to generate a fresh key in the Tailscale admin
  console).
- Re-running `install.sh` after a partial or full prior run is always safe:
  the persisted `runtime.key` is reused, an already-running service is
  stopped and re-registered rather than erroring, and `copy-this.md` is
  simply rewritten.
- Windows getting a Scheduled Task instead of a true SCM service is an
  explicit, documented v1 limitation (see Out of scope) — not a silent
  downgrade.
- Hub unreachable at install time → not this script's problem; if
  self-registration is configured, the binary's own retry loop (already
  implemented) handles it. If not, the operator pastes `copy-this.md`
  whenever they're ready.
- Pasting a connection string for an unreachable machine, or one with a
  wrong key → the hub's new pre-create check rejects it with a specific
  error (see above) instead of registering a broken entry.

## Testing

- Install/uninstall scripts (shell/PowerShell, no Go unit test target):
  1. **`--dry-run` review** — run with `--dry-run` and confirm the printed
     checklist matches expectations (right install commands for the
     detected OS, correctly-derived no-port public URL, right service
     registration commands, correct `copy-this.md` content) without
     mutating anything.
  2. **Manual runbook** — on one throwaway VM/container per target OS:
     copy the bundle, fill in `runtime.env` against a real test hub, run
     `install.sh`/`install.ps1`, confirm the machine appears in the hub's
     Machines page (via self-registration, if configured), reboot the VM,
     confirm the service auto-restarts; separately, re-run the installer
     and confirm it updates the existing service instead of erroring.
- Backend: unit tests for `PostMachine`'s new reachability check —
  success, network failure, and 401-from-key-mismatch cases, using
  `httptest.Server` the same way existing machine tests do. Existing
  self-registration tests (`machineclient` package) need reviewing since
  their `httptest.Server` stubs now need to answer the authenticated probe
  route too, not just `POST`/`PATCH /api/machines`.
- Frontend: the paste-connection-string form's client-side parsing/
  validation (malformed input rejected before submit) and that
  `useCreateMachine` is actually invoked on valid submit.

## Out of scope

- A true Windows Service (SCM) implementation — would require adding a Go
  service-wrapper dependency (e.g. `golang.org/x/sys/windows/svc`) to the
  binary itself. The Scheduled-Task-at-logon approach avoids that
  dependency for v1; revisit if unattended (pre-login) start on Windows
  becomes a real requirement.
- A `curl | sh` style installer that downloads the binary directly from
  GitHub releases — rejected because the release repo is private and this
  would require a GitHub token on every new machine (see Decision 4).
- Automatic Tailscale ACL/tag configuration — the operator's existing
  tailnet ACLs (from the hub/runtime design) are assumed already in place;
  this script only runs `tailscale up`, it doesn't touch ACL policy.
- Removing a machine from the hub's registry, or revoking its Tailscale
  node — `uninstall.sh`/`uninstall.ps1` only undoes the local service
  registration.
- Auto-updating an already-installed runtime — the existing `--updates`
  self-update flag (GitHub-token-based) already covers that once a runtime
  is running; this project only covers first-time bootstrap.
- Removing or deprecating self-registration — it stays exactly as
  implemented; this project only adds an alternative path alongside it.
- A "test connection" preview before submit in the paste-string UI — the
  reachability+auth check happens as part of the actual `POST
  /api/machines` call itself, not as a separate dry-run probe endpoint.
