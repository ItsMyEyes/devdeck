# One-line installer scripts (`curl | sh`, PowerShell, cmd)

**Date:** 2026-07-26
**Status:** Approved

## Problem

Getting DevDeck onto a new machine today means cloning the repo, installing Go
1.25 and Node 22, and running `make`. That is a reasonable story for a
contributor and a bad one for an operator who just wants to add a runtime
machine to an existing hub.

The release pipeline already cross-compiles a static, CGO-free binary for six
platforms (`.github/workflows/release.yml`), so the ingredients for a
download-and-go install already exist — nothing consumes them.

Two defects block that consumption and are fixed as part of this work:

1. `release.yml:66` publishes assets as `devdeck-runtime-<os>-<arch>`, but
   `backend/internal/selfupdate/asset.go:8` looks for `devdeck-<os>-<arch>`.
   `PickAsset` can never match a real release asset.
2. `backend/internal/selfupdate/run.go:14` sets `Repo = "enginer-workspaces"`,
   but the repository is `ItsMyEyes/devdeck`. The self-update API call targets
   a repo that does not exist.

Together these mean the shipped `--updates` flag is inert.

## Goals

- One command installs DevDeck on Linux, macOS, and Windows.
- The same command can optionally register the machine as a runtime against an
  existing hub, end to end, and verify that it worked.
- Fix `selfupdate` so `--updates` resolves a real asset from the real repo.

## Non-goals

- **No service/autostart registration.** No systemd unit, launchd plist, or
  Scheduled Task. The installer may start a detached process, but nothing
  survives a reboot. Deliberate: per-OS service management is a separate,
  larger piece of work.
- **No source builds.** The installer downloads binaries and never invokes a
  toolchain.
- **No desktop-app install.** The Tauri `.dmg`/`.msi`/`.deb` bundles keep their
  existing manual download flow.
- **No uninstall script.** Removal is deleting one binary and one config dir;
  the installer prints both paths.

## Constraints that shape the design

**The repository is private.** `GET api.github.com/repos/ItsMyEyes/devdeck`
returns 404 unauthenticated, and so does `raw.githubusercontent.com`. Anonymous
`curl | sh` is not available.

**GitHub Pages for this repo is already public.** `itsmyeyes.github.io/devdeck/`
redirects to the custom domain `kiyora.is-a.dev/devdeck/`, and Pages content is
served publicly even though the repo is private. `.github/workflows/deploy-docs.yml`
publishes the Fumadocs static export there on `v*.*.*` tags.

This splits the trust story cleanly: **the script is fetched from a public URL
with no credential; only the binary download needs a token.** The user can read
the script before piping it, which is the single most important property of a
`curl | sh` installer.

## User-facing interface

```bash
# Linux / macOS — install only
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh

# Linux / macOS — install and self-register as a runtime
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh
```

```powershell
# Windows PowerShell 5.1+ / pwsh 7
$env:GITHUB_TOKEN="ghp_xxx"; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

```bat
:: Windows cmd.exe
curl -fsSL https://kiyora.is-a.dev/devdeck/install.cmd -o %TEMP%\dd.cmd && %TEMP%\dd.cmd
```

`install.cmd` is a shim: it re-invokes `powershell -NoProfile -ExecutionPolicy
Bypass -Command "irm .../install.ps1 | iex"`. `%GITHUB_TOKEN%` and the other
`DEVDECK_*` variables need no explicit forwarding — the PowerShell child
process inherits the cmd.exe environment. The shim exists so the documented
cmd.exe path is a file the user can inspect, not a quoted incantation.

## Environment contract

Variable names are identical to the flag-backing env vars already read by
`backend/cmd/server/main.go:43-71`, so the generated config file can be sourced
directly with no translation layer.

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | — | **Required.** Fine-grained token with Contents: read on `ItsMyEyes/devdeck`. |
| `DEVDECK_VERSION` | `latest` | Pin to a tag, e.g. `v1.3.0`. |
| `DEVDECK_INSTALL_DIR` | `~/.local/bin` (Unix), `%LOCALAPPDATA%\DevDeck\bin` (Windows) | Never requires sudo or elevation. |
| `DEVDECK_ROLE` | `runtime` | `runtime` \| `hub` \| `both`. |
| `DEVDECK_ADDR` | `0.0.0.0:8989` when self-registering, else `127.0.0.1:8989` | See "Bind address" below. |
| `DEVDECK_HUB_URL` | — | Hub base URL. Both this and `DEVDECK_HUB_KEY` present ⇒ self-registration runs. |
| `DEVDECK_HUB_KEY` | — | Hub bearer key for the self-registration call. |
| `DEVDECK_KEY` | generated 32 random bytes, hex | This runtime's own API key. |
| `DEVDECK_PUBLIC_URL` | `tailscale ip -4`, else first non-loopback IP | URL advertised to the hub. |
| `DEVDECK_MACHINE_NAME` | OS hostname | Display name in the Machines UI. |
| `DEVDECK_NO_START` | unset | Set to `1` to write config and stop without launching. |

**Bind address.** Defaulting to `0.0.0.0` when self-registering is intentional:
a runtime the hub cannot reach is useless, and `--role runtime` refuses to start
without `--key`, so every route except `GET /api/health` is already behind
bearer auth (`CONTRACTS.md`, "Key auth"). Install-only runs keep the loopback
default because nothing has established that the machine should be reachable.

## Flow

```
detect ──► resolve ──► download ──► verify ──► install ──► [configure ──► start ──► confirm]
```

### detect

`uname -s` maps `Darwin`→`darwin`, `Linux`→`linux`; anything else is a hard
error listing the supported set. `uname -m` maps `x86_64`/`amd64`→`amd64`,
`arm64`/`aarch64`→`arm64`.

On Darwin, `uname -m` reports `x86_64` when the shell is running under Rosetta
on Apple Silicon. `sysctl -n sysctl.proc_translated` returning `1` means
translated, so the arch is corrected to `arm64` — otherwise every Rosetta-shell
user silently installs the slow binary.

PowerShell uses `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture`,
falling back to `$env:PROCESSOR_ARCHITEW6432` then `$env:PROCESSOR_ARCHITECTURE`
on hosts where the type is unavailable. `install.ps1` on a non-Windows host
exits with a pointer to `install.sh` rather than guessing.

### resolve

`GET /repos/ItsMyEyes/devdeck/releases/latest`, or `/releases/tags/$DEVDECK_VERSION`
when pinned, with `Authorization: Bearer <token>` and
`Accept: application/vnd.github+json`. Find the asset named
`devdeck-runtime-<os>-<arch>` (`.exe` suffix on Windows) and take its numeric
`id`.

`install.sh` uses `jq` when it is on `PATH`. When it is not — the common case on
a bare machine — it falls back to a `sed`/`grep` parser. That parser is the one
genuinely fragile piece of the script, so it is a pure function tested against a
captured GitHub response fixture, and it hard-errors with a clear message when
the extracted id is not numeric rather than proceeding with garbage.

`install.ps1` uses `Invoke-RestMethod`, which deserializes to objects; no manual
parsing.

### download

`GET /repos/.../releases/assets/<id>` with `Accept: application/octet-stream`.
This is the correct endpoint for private-repo assets and matches what
`backend/internal/selfupdate/github.go` already does. `browser_download_url` is
not used.

`curl` is preferred; `wget` is used when `curl` is absent. Neither present is a
hard error naming both.

### verify

`release.yml` gains a step that writes `checksums.txt` (`sha256sum` over the
`devdeck-runtime-*` assets) and attaches it to the release. The installer
downloads it, extracts the line for its asset, and compares against locally
computed `sha256sum` / `shasum -a 256` / `Get-FileHash`.

Releases cut before this change (v1.3.0 and earlier) have no manifest. A missing
`checksums.txt` is a **warning, not a failure** — otherwise the installer cannot
install any release that exists today. A manifest that is present but does not
match is a hard failure.

### install

Write to a temporary file in the destination directory (same filesystem), set
mode `0755`, then `mv` into place. The rename is atomic, so a concurrent or
interrupted install never leaves a half-written binary named `devdeck`.

The destination directory is created if absent. If it is not writable, the error
names `DEVDECK_INSTALL_DIR` as the remedy — the installer never escalates. If the
directory is not on `PATH`, the script prints the exact `export PATH=...` line
for the detected shell (and the `setx` equivalent on Windows).

macOS Gatekeeper does not quarantine files fetched by `curl` — only browsers set
`com.apple.quarantine` — so no `xattr` handling is needed.

### configure

Runs only when both `DEVDECK_HUB_URL` and `DEVDECK_HUB_KEY` are set.

Generates `DEVDECK_KEY` if unset (32 bytes from `/dev/urandom`, hex-encoded;
`RandomNumberGenerator` on Windows), then writes `~/.config/devdeck/runtime.env`
(`%APPDATA%\DevDeck\runtime.env`) at mode `0600` containing every resolved
`DEVDECK_*` value. An existing file is backed up to `runtime.env.bak` before
being replaced, so re-running the installer never silently destroys a key that
the hub already knows about.

### start

`nohup devdeck >> ~/.local/state/devdeck/runtime.log 2>&1 &`, detached, with the
env file sourced first. Windows uses `Start-Process -WindowStyle Hidden`. The
PID and log path are printed.

The script states plainly that this process does not survive a reboot and prints
the command to start it again. Skipped entirely under `DEVDECK_NO_START=1`.

### confirm

Poll `GET http://127.0.0.1:<port>/api/health` — where `<port>` is the port half
of the resolved `DEVDECK_ADDR` — until 200, up to 15 seconds. Then
`GET $DEVDECK_HUB_URL/api/machines` with the hub key and check that
`DEVDECK_MACHINE_NAME` appears in the response.

Only after both checks pass does the installer report success. A local health
check alone would report success for a runtime the hub never registered, which
is exactly the failure this step exists to catch. Health-check timeout points at
the log file; a successful health check with the machine missing from the hub
reports a registration failure specifically.

## Failure handling

Every failure exits non-zero with one actionable line — no stack traces, no
partial-success ambiguity:

| Condition | Message |
|---|---|
| No `curl` and no `wget` | Install one of them |
| Token unset | How to create a fine-grained token and which scope |
| 401 / 403 | Token invalid or lacks access to the private repo |
| 404 on release | Tag does not exist, or the token cannot see the repo |
| Unsupported OS/arch | The six supported combinations, listed |
| Asset id unparseable | GitHub response shape changed; install `jq` and retry |
| Checksum mismatch | Hard fail, both hashes shown |
| Install dir unwritable | Set `DEVDECK_INSTALL_DIR` |
| Health check timeout | Log file path |
| Registered locally but absent from hub | Hub URL/key mismatch |

**Pipe safety.** The whole script body lives in `main()`, invoked on the last
line. A truncated download therefore executes nothing, instead of executing a
prefix of the installer. `set -eu` plus a `trap` that removes the temp directory
on any exit.

`install.sh` targets POSIX `sh` — no bashisms, no arrays, no `[[ ]]` — so it
runs under dash, ash/busybox, bash, and zsh alike.

## Changes outside `scripts/`

| File | Change |
|---|---|
| `backend/internal/selfupdate/asset.go` | `AssetName` returns `devdeck-runtime-<os>-<arch>` |
| `backend/internal/selfupdate/run.go` | `Repo = "devdeck"` |
| `backend/internal/selfupdate/asset_test.go` | Expectations updated to the new names |
| `.github/workflows/deploy-docs.yml` | Copy `scripts/install.{sh,ps1,cmd}` into `docs-site/out/` before the Pages artifact upload |
| `.github/workflows/release.yml` | Generate and attach `checksums.txt` |
| `.github/workflows/test.yml` | Run `shellcheck -s sh` and the installer unit tests |
| `README.md`, `COMMANDS.md`, `TUTORIAL.md` | Install section with the one-liners |

## Testing

`scripts/test/install_test.sh` sources `install.sh` with `DEVDECK_INSTALL_TEST=1`
set, which makes the final `main "$@"` a no-op, and exercises the pure functions:

- `detect_os` / `detect_arch` across the `uname` strings for all six platforms,
  including the Rosetta correction path with `sysctl` stubbed.
- `asset_name` for each os/arch pair, including the `.exe` suffix.
- `parse_asset_id` against a captured GitHub `releases/latest` fixture,
  asserting it picks the right id when several assets are present, and that it
  fails loudly on a malformed body.
- `checksum_for` extracting the correct line from a `checksums.txt` fixture.

Network, download, and installation paths are verified manually once per
platform rather than mocked — mocking an HTTP client in POSIX sh costs more than
it proves.

`shellcheck -s sh scripts/install.sh` must pass clean. `install.ps1` is checked
with `PSScriptAnalyzer` if available in CI, otherwise reviewed by hand.

## Open risks

**Nothing is published yet.** `ItsMyEyes/devdeck` currently has **zero GitHub
releases**, and no tags are pushed to `origin` (`git ls-remote --tags origin` is
empty; the `v1.0.0`–`v1.3.0` tags exist only locally). `release.yml` has
therefore never run, so there are no `devdeck-runtime-*` assets to download.
Both this installer and the existing `--updates` flag stay inert until
`make tag VERSION=vX.Y.Z` pushes a tag and the release workflow completes.

A consequence: the "missing `checksums.txt` is a warning" rule protects against
releases cut between this change landing and the CI checksum step landing, not
against a back catalogue — there is no back catalogue.

**The Pages URL goes live on the same tag.** `deploy-docs.yml` also only runs on
`v*.*.*`, so `kiyora.is-a.dev/devdeck/install.sh` 404s until that first tag.
The README documents the `raw.githubusercontent.com` + token form as an
explicitly temporary fallback, to be deleted once the Pages URL resolves.

**Field-order dependency in the jq-less parser.** The fallback parser anchors on
GitHub emitting `"url"`, `"id"`, `"node_id"`, `"name"` in that order within each
asset object, and on stripping all whitespace from the response first (the API
pretty-prints, so `"id": 123` has a space the pattern would otherwise miss).
Verified against a live response on 2026-07-26. If GitHub reorders those fields
the parser fails loudly rather than silently picking a wrong id, and installing
`jq` is the documented workaround.
