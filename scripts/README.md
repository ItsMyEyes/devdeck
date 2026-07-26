# Installer scripts

One-line installers for the DevDeck server binary. Design and rationale:
[`docs/superpowers/specs/2026-07-26-install-scripts-design.md`](../docs/superpowers/specs/2026-07-26-install-scripts-design.md).

| File | Platform |
|---|---|
| `install.sh` | Linux, macOS — POSIX `sh` (dash, ash/busybox, bash, zsh) |
| `install.ps1` | Windows — PowerShell 5.1+ and pwsh 7 |
| `install.cmd` | Windows — a shim that runs `install.ps1` via PowerShell |

## Usage

```bash
# Linux / macOS
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh

# Linux / macOS, registering as a runtime against an existing hub
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh
```

```powershell
$env:GITHUB_TOKEN="ghp_xxx"; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

```bat
curl -fsSL https://kiyora.is-a.dev/devdeck/install.cmd -o %TEMP%\dd.cmd && %TEMP%\dd.cmd
```

`GITHUB_TOKEN` is required because `ItsMyEyes/devdeck` is private. Create a
fine-grained token with **Contents: read** on the repo. The scripts themselves
are served from the public Pages site, so only the binary download is
authenticated — read the script before you pipe it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | — | **Required.** Fine-grained token, Contents: read. |
| `DEVDECK_VERSION` | `latest` | Pin to a tag, e.g. `v1.4.0`. |
| `DEVDECK_INSTALL_DIR` | `~/.local/bin`, `%LOCALAPPDATA%\DevDeck\bin` | Never needs sudo. |
| `DEVDECK_ROLE` | `runtime` | `runtime`, `hub`, or `both`. |
| `DEVDECK_ADDR` | `0.0.0.0:8989` self-registering, else `127.0.0.1:8989` | Listen address. |
| `DEVDECK_HUB_URL` + `DEVDECK_HUB_KEY` | — | Both set ⇒ self-registration runs. |
| `DEVDECK_KEY` | generated | This runtime's API key. |
| `DEVDECK_PUBLIC_URL` | Tailscale IP, else first non-loopback IP | Advertised to the hub. |
| `DEVDECK_MACHINE_NAME` | hostname | Name in the Machines UI. |
| `DEVDECK_NO_START` | unset | `1` writes config without starting anything. |

## What it does not do

No service is installed — no systemd unit, launchd plist, or Scheduled Task.
A runtime started by the installer **does not survive a reboot**; the script
prints the command to start it again.

## Tests

```bash
sh scripts/test/install_test.sh                       # POSIX helpers
shellcheck -s sh scripts/install.sh                   # lint
pwsh -NoProfile -File scripts/test/install_ps_test.ps1 # PowerShell helpers
```

Network and installation paths are verified manually — see the plan's Manual
Verification section.
