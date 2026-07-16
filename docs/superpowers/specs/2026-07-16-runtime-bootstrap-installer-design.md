# Runtime Bootstrap Installer — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorming complete)

## Goal

Today, deploying a new `--role runtime` machine requires the operator to
manually install Tailscale, join the tailnet, figure out the machine's
MagicDNS name, and hand-assemble a long flag/env list
(`--role runtime --key ... --hub-url ... --hub-key ... --public-url ...
--name ... --enable-tailscale-serve`) before starting the binary. For the
solo-operator model this project is built for ("one operator, many
companies/machines"), that manual setup is repeated friction every time a
new desktop is added as a runtime.

This project packages the already-existing runtime binary together with an
install script that runs a preflight checklist, joins Tailscale
automatically, and starts the runtime as a background service — so adding
a machine becomes: copy one folder, fill in a handful of values once, run
one command.

No backend Go changes are required. Every flag/env var this needs already
exists and works today: `--role`, `--key` (`LOOM_KEY`), `--hub-url`
(`LOOM_HUB_URL`), `--hub-key` (`LOOM_HUB_KEY`), `--public-url`
(`LOOM_PUBLIC_URL`), `--name` (`LOOM_MACHINE_NAME`), and
`--enable-tailscale-serve` (`LOOM_TAILSCALE_SERVE`) — see
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md` and
`docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md`. This
project is purely a packaging + bootstrap layer on top of those.

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
LOOM_HUB_URL=https://hub.tail-xxxx.ts.net
LOOM_HUB_KEY=<hub's bearer key>
TS_AUTHKEY=<reusable Tailscale auth key from the admin console>
# LOOM_MACHINE_NAME=   (optional; defaults to OS hostname)
# LOOM_ADDR=           (optional; defaults to 127.0.0.1:8989)
```

`LOOM_KEY` is deliberately not in this template — see Decision 6.

### Install script flow (`install.sh` macOS/Linux, `install.ps1` Windows)

1. **Preflight** — confirm `runtime.env` exists next to the script and that
   `LOOM_HUB_URL`, `LOOM_HUB_KEY`, `TS_AUTHKEY` are present and don't still
   contain the placeholder text from the template. Missing/placeholder
   values fail fast, naming the exact variable.
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
   `.Self.DNSName` (strip the trailing dot), combine with the port from
   `LOOM_ADDR` (default `8989`) to build
   `--public-url=https://<dnsname>:<port>`.
4. **Generate & persist `LOOM_KEY`** — if a local key file
   (`./runtime.key`, `chmod 600`) doesn't already exist, generate 32 random
   bytes hex-encoded and write it; if it exists (re-run), reuse it. This
   makes re-running the installer idempotent.
5. **Register as a background service**, passing all config as environment
   variables (`LOOM_ROLE=runtime`, `LOOM_KEY`, `LOOM_HUB_URL`,
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
6. **Print a checklist summary** as each step completes (✓ Tailscale
   installed / ✓ joined tailnet as `<dnsname>` / ✓ runtime key ready / ✓
   background service registered), ending with the derived `.ts.net` URL.
   Self-registration (already implemented) takes it from there — the
   runtime's existing retry loop registers it with the hub in the
   background; the install script does not need to wait for or verify that
   call.

### `--dry-run` mode

Both scripts accept a `--dry-run` flag that runs the preflight and prints
every action it *would* take (installs, `tailscale up`, service
registration) without executing any of them. This is the only way to
exercise the script's logic without mutating a real machine (see Testing).

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

## Error handling

- Missing/placeholder `runtime.env` values → fail fast, name the exact
  variable, exit non-zero before touching Tailscale or the service manager.
- Invalid or expired `TS_AUTHKEY` → surfaced verbatim from `tailscale up`'s
  own error output; script exits non-zero rather than retrying silently
  (the operator needs to generate a fresh key in the Tailscale admin
  console).
- Re-running `install.sh` after a partial or full prior run is always safe:
  the persisted `runtime.key` is reused, and service registration
  overwrites the existing unit/plist/task cleanly rather than erroring on
  "already exists".
- Windows getting a Scheduled Task instead of a true SCM service is an
  explicit, documented v1 limitation (see Out of scope) — not a silent
  downgrade.
- Hub unreachable at install time → not this script's problem; the
  binary's own self-registration retry loop (already implemented) handles
  it, logging and retrying until the hub is reachable.

## Testing

- These are shell/PowerShell scripts, not Go — no unit test target. Two
  layers of verification:
  1. **`--dry-run` review** — run the script with `--dry-run` and confirm
     the printed checklist matches expectations (right install commands
     for the detected OS, right derived public URL format, right service
     registration commands) without mutating anything.
  2. **Manual runbook** — on one throwaway VM/container per target OS:
     copy the bundle, fill in `runtime.env` against a real test hub, run
     `install.sh`/`install.ps1`, confirm the machine appears in the hub's
     Machines page, reboot the VM, confirm the service auto-restarts and
     the runtime re-appears reachable.
- Existing backend tests (self-registration, key auth, tailscale-serve
  flag) are unaffected — this project adds no Go code.

## Out of scope

- Any backend Go changes — every flag/env var needed already exists.
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
